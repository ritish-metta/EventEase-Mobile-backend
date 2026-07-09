const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();

function aesEncrypt(plainText, key) {
  // Method: SHA1 hash truncated to 16 bytes  
  const keyBytes = crypto.createHash('sha1')
    .update(key, 'utf8')
    .digest()
    .slice(0, 16);
    
  const iv = Buffer.alloc(16, 0);

  const cipher = crypto.createCipheriv('aes-128-cbc', keyBytes, iv);
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

router.post('/prisoner-details', async (req, res) => {
  try {
    const { jailcode, releasefromdate, releasetodate } = req.body;

    // Step 1 - Encrypt login
    const loginPayload = JSON.stringify({
      userid: "Telanganapolice01",
      password: "telPolice@036"
    }); 
    const encryptedLogin = aesEncrypt(loginPayload, "!gan#*tel)!Pol&^");

    console.log('=== DEBUG ===');
    console.log('loginPayload:', loginPayload); 
    console.log('encryptedLogin:', encryptedLogin);
    console.log('key length:', "!gan#*tel)!Pol&^".length);

    // Step 2 - Get JWT token 
    const tokenResponse = await axios.post(
      'https://eprisons.nic.in/ePrisonsAPI/api/Token',
      { inputdata: encryptedLogin },
      { headers: { 'Content-Type': 'application/json' } }
    );
 
    console.log('Token API response:', JSON.stringify(tokenResponse.data));

    if (!tokenResponse.data.status) {
      return res.status(401).json({ 
        success: false, 
        message: 'Token generation failed',
        debug: tokenResponse.data
      });
    }

    const jwtToken = tokenResponse.data.data;

    const prisonerPayload = JSON.stringify({
      jailcode,
      releasefromdate,
      releasetodate,
      casedetails: "true",
      visitordetails: "true"
    });
    const encryptedPrisoner = aesEncrypt(
      prisonerPayload, 
      "!gan#*tel)!Pol&^"
    );

    const encodedString = encodeURIComponent(encryptedPrisoner);
    const prisonerResponse = await axios.get(
      `https://eprisons.nic.in/eprisonsapi/api/ePrisons/PrisonerAdmissionReleaseDetails?reqstring=${encodedString}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwtToken}`
        }
      }
    );

    res.json({
      success: true,
      data: prisonerResponse.data
    });

  } catch (err) {
    console.log('ERROR:', err.message);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});




module.exports = router;