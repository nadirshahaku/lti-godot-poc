require("dotenv").config();

const path = require("path");
const express = require("express");
const lti = require("ltijs").Provider;
const jwt = require("jsonwebtoken");

// In-memory token cache (for production, consider Redis)
const tokenCache = new Map();

// 1) Setup Ltijs (MongoDB is required by ltijs)
lti.setup(
  process.env.LTI_ENCRYPTION_KEY,
  { url: process.env.LTI_DB_URL },
  {
    appRoute: "/launch",
    loginRoute: "/login",
    keysetRoute: "/keys",
    cookies: { secure: true, sameSite: "none" },
    devMode: false
  }
);

// 2) Middleware + static files
lti.app.use(express.json());
lti.app.use(express.static(path.join(__dirname, "..", "public")));

// Friendly home page
lti.app.get("/", (req, res) => {
  res.send(`
    <h2>LTI Godot POC</h2>
    <p>This tool must be launched from Moodle.</p>
    <p>Health: <a href="/health">/health</a></p>
  `);
});

lti.app.get("/health", (req, res) => res.send("OK"));

// Test endpoint to verify keys are available
lti.app.get("/test-keys", async (req, res) => {
  try {
    const platform = await lti.getPlatform("https://quizgametest.moodlecloud.com", "GzMJPZMQfLMVRts", "2");
    res.json({
      keysEndpoint: "/keys",
      fullKeysUrl: "https://lti-godot-poc.onrender.com/keys",
      platformRegistered: !!platform,
      message: "Your tool's public keys are available at the 'fullKeysUrl' above. Configure this URL in Moodle."
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3) LTI Launch handler - STORE token in cache
lti.onConnect((token, req, res) => {
  const ltik = req.query.ltik || "";

  console.log("=== LTI Launch ===");
  console.log("User:", token.user);
  console.log("Has lineitem:", !!token.platformContext?.endpoint?.lineitem);
  console.log("Lineitem URL:", token.platformContext?.endpoint?.lineitem);
  console.log("LTIK:", ltik);

  // Store the complete token in cache using ltik as key
  if (ltik) {
    tokenCache.set(ltik, token);
    console.log("Token cached successfully");
    
    // Auto-expire after 2 hours
    setTimeout(() => {
      if (tokenCache.has(ltik)) {
        tokenCache.delete(ltik);
        console.log("Token expired and removed from cache");
      }
    }, 2 * 60 * 60 * 1000);
  }

  return res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Godot LTI POC</title>
</head>
<body style="font-family:sans-serif;margin:16px;">
  <h2>Godot LTI POC</h2>
  <p>Game loads below:</p>

  <iframe
    src="/game/index.html?ltik=${encodeURIComponent(ltik)}"
    style="width:960px;height:600px;border:1px solid #ccc;border-radius:8px;"
  ></iframe>
</body>
</html>
  `);
});

// 4) Token validation using cache
async function validateLtik(req, res, next) {
  try {
    const ltik = req.query.ltik || req.body.ltik;
    
    if (!ltik) {
      console.error("No ltik provided");
      return res.status(401).send("Unauthorized: missing ltik");
    }

    console.log("Validating ltik...");
    console.log("Cache size:", tokenCache.size);
    console.log("LTIK in cache:", tokenCache.has(ltik));

    // Verify JWT signature first
    try {
      jwt.verify(ltik, process.env.LTI_ENCRYPTION_KEY);
      console.log("JWT signature verified");
    } catch (err) {
      console.error("JWT verification failed:", err.message);
      return res.status(401).send("Unauthorized: invalid token signature");
    }

    // Get token from cache
    const tokenData = tokenCache.get(ltik);

    if (!tokenData) {
      console.error("Token not found in cache");
      console.log("Available tokens in cache:", Array.from(tokenCache.keys()).map(k => k.substring(0, 20) + '...'));
      return res.status(401).send("Unauthorized: token not found or expired");
    }

    console.log("Token retrieved from cache successfully");
    console.log("Token user:", tokenData.user);
    console.log("Has endpoint:", !!tokenData.platformContext?.endpoint);
    
    // Attach token to res.locals for the route handler
    res.locals.token = tokenData;
    next();

  } catch (err) {
    console.error("Token validation error:", err.message);
    console.error("Stack:", err.stack);
    return res.status(401).send("Unauthorized: " + err.message);
  }
}

// 5) Grade endpoint
lti.app.post("/api/update", validateLtik, async (req, res) => {
  try {
    console.log("=== Grade Update Request ===");
    console.log("Body:", req.body);

    const idtoken = res.locals.token;

    console.log("Token user:", idtoken.user);
    console.log("Has platformContext:", !!idtoken.platformContext);
    console.log("Has endpoint:", !!idtoken.platformContext?.endpoint);
    console.log("Has lineitem:", !!idtoken.platformContext?.endpoint?.lineitem);

    const score = Number(req.body.score || 0);
    const attempts = Number(req.body.attempts || 0);
    const scoreClamped = Math.max(0, Math.min(10, score));

    console.log(`Submitting grade: ${scoreClamped}/10 (attempts: ${attempts})`);

    // Build grade object according to LTI AGS spec (v2.0)
    // NOTE: userId should NOT be in the score object per LTI AGS spec
    // It's determined from the access token context
    const gradeObj = {
      scoreGiven: scoreClamped,
      scoreMaximum: 10,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
      timestamp: new Date().toISOString()
    };

    console.log("Grade object:", JSON.stringify(gradeObj, null, 2));
    console.log("Token info for submission:");
    console.log("  - User:", idtoken.user);
    console.log("  - Platform:", idtoken.platformUrl);
    console.log("  - ClientId:", idtoken.clientId);

    // Get line item from token
    let lineItemId = idtoken?.platformContext?.endpoint?.lineitem;
    
    console.log("LineItemId from token:", lineItemId);

    if (!lineItemId) {
      console.log("No lineItemId in token, attempting to fetch...");
      
      try {
        const lineItemsResponse = await lti.Grade.getLineItems(idtoken, {
          resourceLinkId: true
        });
        
        console.log("Line items response:", lineItemsResponse);

        if (lineItemsResponse?.lineItems?.length > 0) {
          lineItemId = lineItemsResponse.lineItems[0].id;
          console.log("Using existing lineItemId:", lineItemId);
        } else {
          console.log("Creating new line item...");
          const created = await lti.Grade.createLineItem(idtoken, {
            scoreMaximum: 10,
            label: "Game Score",
            tag: "score",
            resourceLinkId: idtoken.platformContext?.resource?.id
          });
          lineItemId = created.id;
          console.log("Created new lineItemId:", lineItemId);
        }
      } catch (lineItemError) {
        console.error("Error with line item:", lineItemError.message);
        console.error("Full error:", lineItemError);
      }
    }

    if (!lineItemId) {
      console.error("No lineItemId available - cannot submit grade");
      return res.status(400).json({ 
        error: "No line item available for grade submission"
      });
    }

    // Submit the score
    console.log("Submitting score to lineItemId:", lineItemId);
    
    try {
      const result = await lti.Grade.submitScore(idtoken, lineItemId, gradeObj);
      
      console.log("Grade submission result:", result);
      console.log("=== Grade Update Success ===");

      return res.json({ 
        ok: true, 
        score: scoreClamped,
        attempts: attempts,
        lineItemId: lineItemId,
        result: result
      });
    } catch (submitError) {
      console.error("=== Grade Submission Failed ===");
      console.error("Error message:", submitError.message);
      console.error("Error response:", submitError.response?.body);
      console.error("Error statusCode:", submitError.response?.statusCode);
      console.error("Full error:", submitError);
      
      return res.status(500).json({ 
        error: "Grade submission failed: " + submitError.message,
        details: submitError.response?.body || submitError.stack
      });
    }

  } catch (err) {
    console.error("=== Grade Update Error ===");
    console.error("Error message:", err?.message);
    console.error("Error stack:", err?.stack);
    return res.status(500).json({ 
      error: err?.message || String(err),
      details: err?.stack
    });
  }
});

// 6) Start then register platform
(async () => {
  try {
    const port = process.env.PORT || 3000;

    await lti.deploy({ port });
    console.log("=== Server Running ===");
    console.log("Port:", port);

    await lti.registerPlatform({
      url: "https://quizgametest.moodlecloud.com",
      name: "MoodleCloud QuizGameTest",
      clientId: "GzMJPZMQfLMVRts",
      authenticationEndpoint: "https://quizgametest.moodlecloud.com/mod/lti/auth.php",
      accesstokenEndpoint: "https://quizgametest.moodlecloud.com/mod/lti/token.php",
      authConfig: {
        method: "JWK_SET",
        key: "https://quizgametest.moodlecloud.com/mod/lti/certs.php"
      },
      deploymentId: "2"
    });

    console.log("=== Platform Registered ===");
    console.log("Ready to accept LTI launches from Moodle");
    
  } catch (err) {
    console.error("=== Startup Error ===");
    console.error(err);
    process.exit(1);
  }
})();
