// GitHub write access for "Deploy from the editor":
//  1. make sure this server has an SSH key and show its public half
//  2. after the user adds it on GitHub (Deploy keys, write access), test it
//  3. only when the test passes, switch the project's remote to SSH
// Switching before the key works would break pulls (and CI deploys), so the
// remote is never changed on a failed test.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = path.join(os.homedir(), '.ssh', 'id_ed25519');

// https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git) -> owner/repo
function repoSlug(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

module.exports = function gitaccess(ctx) {
  async function ensureKey() {
    if (!fs.existsSync(KEY)) {
      fs.mkdirSync(path.dirname(KEY), { recursive: true, mode: 0o700 });
      await ctx.run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', KEY, '-C', `ops-agent@${os.hostname()}`]);
    }
    // trust github.com so the first connection doesn't stop at a yes/no question
    const known = path.join(path.dirname(KEY), 'known_hosts');
    const knownText = fs.existsSync(known) ? fs.readFileSync(known, 'utf8') : '';
    if (!knownText.includes('github.com')) {
      const scan = await ctx.safeRun('ssh-keyscan', ['-t', 'ed25519,rsa', 'github.com'], { timeout: 15000 });
      if (scan) fs.appendFileSync(known, `${scan}\n`);
    }
    return fs.readFileSync(`${KEY}.pub`, 'utf8').trim();
  }

  // Status of one project: remote type, repo, whether pushing should work.
  ctx.app.get('/api/projects/:name/git-access', async (req, res) => {
    const proj = await ctx.findProject(req.params.name);
    const remote = await ctx.safeRun('git', ['-C', proj.cwd, 'remote', 'get-url', 'origin']);
    const slug = repoSlug(remote);
    res.json({
      success: true,
      remote,
      repo: slug,
      ssh: Boolean(remote && remote.startsWith('git@')),
      hasKey: fs.existsSync(`${KEY}.pub`),
      deployKeysUrl: slug ? `https://github.com/${slug}/settings/keys/new` : null,
      actionsUrl: slug ? `https://github.com/${slug}/actions` : null,
    });
  });

  // Create (once) and return the server's public key, the thing to paste into GitHub.
  ctx.app.post('/api/git/deploy-key', async (req, res) => {
    const publicKey = await ensureKey();
    res.json({ success: true, publicKey });
  });

  // Test write-capable SSH access to the project's repo; switch the remote only if it works.
  ctx.app.post('/api/projects/:name/git-ssh', async (req, res) => {
    const proj = await ctx.findProject(req.params.name);
    const remote = await ctx.safeRun('git', ['-C', proj.cwd, 'remote', 'get-url', 'origin']);
    const slug = repoSlug(remote);
    if (!slug) throw new ctx.HttpError(400, `Not a GitHub remote: ${remote || 'none'}`);
    await ensureKey();
    const sshUrl = `git@github.com:${slug}.git`;
    try {
      await ctx.run('git', ['ls-remote', '--heads', sshUrl], { timeout: 30000, env: { ...ctx.CLEAN_ENV, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } });
    } catch (err) {
      throw new ctx.HttpError(400, `GitHub refused this server's key (${err.message.split('\n')[0]}). `
        + 'Add the key under Deploy keys with "Allow write access", wait a few seconds and test again. Nothing was changed.');
    }
    await ctx.run('git', ['-C', proj.cwd, 'remote', 'set-url', 'origin', sshUrl]);
    res.json({ success: true, message: `Connected: ${proj.name} now pushes to ${slug} over SSH`, remote: sshUrl });
  });
};
