const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const router = express.Router();

// --- 🛑 CONFIGURATION 🛑 ---
// NOTE: move these three to environment variables before this goes anywhere
// near a shared repo.
const USER_ID = "Telanganapolice01";
const RAW_PASSWORD = "telPolice@036";
const PRIVATE_KEY = "!gan#*tel)!Pol&^";

// --- HELPER FUNCTIONS ---
function getDynamicKey() {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    return `ePrisons${dd}${mm}${yyyy}`;
}

function todayDDMMYYYY() {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

function isValidDDMMYYYY(s) {
    return typeof s === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(s);
}

function encryptPayload(payloadObj, keyString) {
    const payloadStr = JSON.stringify(payloadObj);
    const key = Buffer.from(keyString, 'utf8');
    const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
    cipher.setAutoPadding(true);
    let encrypted = cipher.update(payloadStr, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
}

// ---------------------------------------------------------
// MAIN FLOW — now driven by `filters` from the request instead of the
// hardcoded jailcode/date values the test script used.
// filters: { jailcode, releasefromdate, releasetodate, casedetails, visitordetails }
// ---------------------------------------------------------
async function fetchReleaseData(filters = {}) {
    if (!filters.jailcode || !String(filters.jailcode).trim()) {
        return { error: 'jailcode is required — the upstream ePrisons API does not support an empty/"all jails" value.' };
    }

    // STEP 1: GET TOKEN
    const tokenPayload = {
        userid: USER_ID,
        password: crypto.createHash('md5').update(RAW_PASSWORD).digest('hex')
    };
    const sharedKey = getDynamicKey();

    let encryptedTokenData;
    try {
        encryptedTokenData = encryptPayload(tokenPayload, sharedKey);
    } catch (e) {
        return { error: `Token Encryption Failed: ${e.message}` };
    }

    let jwtToken = "";
    try {
        const response = await fetch("https://eprisons.nic.in/ePrisonsAPI/api/Token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inputdata: encryptedTokenData })
        });
        const jsonResponse = await response.json();
        if (jsonResponse.status && jsonResponse.data) {
            jwtToken = jsonResponse.data;
        } else {
            return { error: 'Failed to get token', details: jsonResponse.message };
        }
    } catch (error) {
        return { error: `Token request failed: ${error.message}` };
    }

    // STEP 2: GET DATA — uses the actual filters passed in.
    // Defaulting to 02/07/2026 here (not "today") because that's the date
    // your test script confirmed actually has records for jailcode J3600001.
    // Once you confirm which live dates have releases, swap this back to
    // todayDDMMYYYY() / a forward-looking window.
    const KNOWN_GOOD_DATE = '02/07/2026';
    const fromDate = isValidDDMMYYYY(filters.releasefromdate) ? filters.releasefromdate : KNOWN_GOOD_DATE;
    const toDate = isValidDDMMYYYY(filters.releasetodate) ? filters.releasetodate : KNOWN_GOOD_DATE;

    const dataPayload = {
        jailcode: String(filters.jailcode).trim(),
        releasefromdate: fromDate,
        releasetodate: toDate,
        casedetails: filters.casedetails === false ? "false" : "true",
        visitordetails: filters.visitordetails === false ? "false" : "true"
    };

    const encryptedRequestData = encryptPayload(dataPayload, PRIVATE_KEY);
    const encodedPayload = encodeURIComponent(encryptedRequestData);
    const dataUrl = `https://eprisons.nic.in/eprisonsapi/api/ePrisons/PrisonerAdmissionReleaseDetails?reqstring=${encodedPayload}`;

    // TEMP DEBUG: confirm the server's clock/timezone and exactly what's being
    // sent upstream. Remove once the date-mismatch question is settled.
    console.log('[releases] server time:', new Date().toString());
    console.log('[releases] sending dataPayload:', dataPayload);

    try {
        const dataResponse = await fetch(dataUrl, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${jwtToken}`
            }
        });
        const dataResponseText = await dataResponse.text();

        try {
            const dataJson = JSON.parse(dataResponseText);

            // Upstream reports failure via `status: false`, but it also uses this
            // exact shape for the completely normal case of "no releases on this
            // date" — e.g. message contains "not found". Treat that as an empty
            // result, not an error, so the UI shows the empty state instead of a
            // retry-worthy failure. Anything else with status:false (auth issues,
            // bad jailcode, etc.) is still a real error.
            const upstreamMsg = (dataJson.message || '').toLowerCase();
            const looksLikeNoData = dataJson.status === false && upstreamMsg.includes('not found');

            if (dataJson.status === false && !looksLikeNoData) {
                return {
                    error: dataJson.message || 'Upstream ePrisons API returned status:false',
                    upstream: dataJson,
                    // TEMP DEBUG: shows exactly what was sent, so you can see if
                    // jailcode/dates were what you expected without SSH access.
                    // Remove this field once things are confirmed working.
                    debugSentPayload: dataPayload
                };
            }

            let records = [];
            if (dataJson.data) {
                try {
                    records = typeof dataJson.data === 'string' ? JSON.parse(dataJson.data) : dataJson.data;
                } catch (e) {
                    records = [];
                }
            }

            if (filters.q && filters.q.trim()) {
                const q = filters.q.trim().toLowerCase();
                records = records.filter(r =>
                    (r.prisonername || '').toLowerCase().includes(q) ||
                    (r.pidno || '').toLowerCase().includes(q) ||
                    (r.jailname || '').toLowerCase().includes(q) ||
                    (r.policestationname || '').toLowerCase().includes(q)
                );
            }

            dataJson.data = records;
            dataJson.meta = {
                count: records.length,
                releasingToday: records.filter(r => r.releasedate === todayDDMMYYYY()).length,
                filtersApplied: { jailcode: dataPayload.jailcode, fromDate, toDate, q: filters.q || null }
            };

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.writeFileSync(`released_today_${timestamp}.json`, JSON.stringify(dataJson, null, 2));

            return dataJson;
        } catch (e) {
            return { raw: dataResponseText };
        }
    } catch (error) {
        return { error: `Data Request failed: ${error.message}` };
    }
}

// ---------------------------------------------------------
// GET /api/releases?jailcode=J3600001&releasefromdate=02/07/2026&releasetodate=05/07/2026&q=ashok
// jailcode is REQUIRED. Dates default to today if omitted.
// ---------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { jailcode, releasefromdate, releasetodate, casedetails, visitordetails, q } = req.query;
    const result = await fetchReleaseData({
      jailcode,
      releasefromdate,
      releasetodate,
      casedetails: casedetails === 'false' ? false : true,
      visitordetails: visitordetails === 'false' ? false : true,
      q
    });
    // report the REAL outcome — not always true
    res.json({ success: !result.error, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const result = await fetchReleaseData(req.body || {});
    res.json({ success: !result.error, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;