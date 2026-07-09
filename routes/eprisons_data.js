const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const router = express.Router();

// --- 🛑 CONFIGURATION 🛑 ---
const USER_ID = "Telanganapolice01";
const RAW_PASSWORD = "telPolice@036";
const PRIVATE_KEY = "!gan#*tel)!Pol&^";

// --- HELPER FUNCTIONS ---
function getDynamicKey() {
    // Generates today's key: ePrisonsddMMYYYY
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    return `ePrisons${dd}${mm}${yyyy}`;
}

function encryptPayload(payloadObj, keyString) {
    const payloadStr = JSON.stringify(payloadObj);
    const key = Buffer.from(keyString, 'utf8');

    // The ePrisons API requires AES-128-CBC mode with the IV set to the same value as the Key
    const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
    cipher.setAutoPadding(true); // Applies PKCS7 padding automatically

    let encrypted = cipher.update(payloadStr, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return encrypted;
}

// --- MAIN TEST FUNCTION (now returns data instead of just logging/saving) ---
async function testTokenApi() {
    console.log("==========================================");
    console.log("🚀 Starting ePrisons API Flow...");
    console.log("==========================================\n");

    // ---------------------------------------------------------
    // STEP 1: GET TOKEN (Using Dynamic Shared Key)
    // ---------------------------------------------------------
    const tokenPayload = {
        userid: USER_ID,
        password: crypto.createHash('md5').update(RAW_PASSWORD).digest('hex')
    };

    const sharedKey = getDynamicKey();
    console.log(`🔑 Using Dynamic Shared Key for Token : ${sharedKey}`);

    let encryptedTokenData;
    try {
        encryptedTokenData = encryptPayload(tokenPayload, sharedKey);
    } catch (e) {
        console.error(`❌ Token Encryption Failed: ${e.message}`);
        return { error: `Token Encryption Failed: ${e.message}` };
    }

    console.log("\n📡 Sending Request to Token API...");
    let jwtToken = "";

    try {
        const response = await fetch("https://eprisons.nic.in/ePrisonsAPI/api/Token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inputdata: encryptedTokenData })
        });

        const jsonResponse = await response.json();
        console.log(`✅ Token API Status: ${response.status}`);

        if (jsonResponse.status && jsonResponse.data) {
            jwtToken = jsonResponse.data;
            console.log("📦 JWT Token Received Successfully.");
        } else {
            console.error("❌ Failed to get token:", jsonResponse.message);
            return { error: 'Failed to get token', details: jsonResponse.message };
        }
    } catch (error) {
        console.error("❌ Token request failed:", error.message);
        return { error: `Token request failed: ${error.message}` };
    }

    // ---------------------------------------------------------
    // STEP 2: GET DATA (Using Private Key + JWT Token)
    // ---------------------------------------------------------
    console.log("\n==========================================");
    console.log("📡 Requesting Prisoner Details...");

    // Using sample payload from the docx
    const dataPayload = {
        jailcode: "J3600001", // Make sure this jailcode is correct for Telangana
        releasefromdate: "02/07/2026",
        releasetodate: "02/07/2026",
        casedetails: "true",
        visitordetails: "true"
    };

    console.log(`🔑 Using Private Key for Data : ${PRIVATE_KEY}`);
    const encryptedRequestData = encryptPayload(dataPayload, PRIVATE_KEY);

    // UTF-8 Encode the API URL payload as requested in the docx
    const encodedPayload = encodeURIComponent(encryptedRequestData);
    const dataUrl = `https://eprisons.nic.in/eprisonsapi/api/ePrisons/PrisonerAdmissionReleaseDetails?reqstring=${encodedPayload}`;

    try {
        const dataResponse = await fetch(dataUrl, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${jwtToken}`
            }
        });

        const dataResponseStatus = dataResponse.status;
        const dataResponseText = await dataResponse.text();

        console.log(`\n✅ HTTP Status: ${dataResponseStatus}`);

        try {
            const dataJson = JSON.parse(dataResponseText);
            console.log("📦 JSON Response parsed.");

            // Analyze the payload collections
            let records = [];
            if (dataJson.data) {
                try {
                    // Check if data is stringified JSON and parse it, otherwise use directly
                    records = typeof dataJson.data === 'string' ? JSON.parse(dataJson.data) : dataJson.data;
                } catch (e) {
                    console.error("❌ Failed to parse data array:", e.message);
                }
            }

            // For 1 request, how many unique collections (records) we are getting
            const uniqueRecords = new Set(records.map(r => r.pidno));
            console.log(`📊 Analysis: Received ${records.length} total collections (records).`);
            console.log(`📊 Analysis: ${uniqueRecords.size} unique prisoner collections found.`);

            // Replace stringified data with actual array for cleaner JSON saving
            dataJson.data = records;

            // Store per response collections in JSON (still saved to disk too)
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `released_today_${timestamp}.json`;

            fs.writeFileSync(filename, JSON.stringify(dataJson, null, 2));
            console.log(`✅ Data successfully saved to ${filename}`);

            return dataJson; // ✅ returned so the route can send it back to Postman
        } catch (e) {
            console.log("📦 Raw Response (Not JSON):");
            console.log(dataResponseText);
            return { raw: dataResponseText };
        }
    } catch (error) {
        console.error("\n❌ Data Request failed:", error.message);
        return { error: `Data Request failed: ${error.message}` };
    }
}

// GET /api/test  → runs the flow and sends the result back in the response
router.get('/', async (req, res) => {
  try {
    const result = await testTokenApi();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;