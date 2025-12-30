require("dotenv").config();

const path = require("path");
const express = require("express");
const lti = require("ltijs").Provider;

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

// 3) LTI Launch handler
lti.onConnect((token, req, res) => {
  const ltik = req.query.ltik || "";

  console.log("=== LTI Launch ===");
  console.log("User:", token.user);
  console.log("Context:", token.platformContext);
  console.log("Endpoint:", token.platformContext?.endpoint);

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

// 4) Grade endpoint - CRITICAL: Use ltijs middleware to validate ltik
lti.app.post("/api/update", lti.appRoute(), async (req, res) => {
  try {
    console.log("=== Grade Update Request ===");
    console.log("Body:", req.body);

    // Get the validated token from ltijs middleware
    const idtoken = res.locals.token;
    if (!idtoken) {
      console.error("No token found in res.locals");
      return res.status(401).send("Unauthorized: missing/invalid ltik");
    }

    console.log("Token user:", idtoken.user);
    console.log("Token platform context:", idtoken.platformContext);

    const score = Number(req.body.score || 0);
    const attempts = Number(req.body.attempts || 0);
    const scoreClamped = Math.max(0, Math.min(10, score));

    console.log(`Submitting grade: ${scoreClamped}/10 (attempts: ${attempts})`);

    // Build grade object according to LTI AGS spec
    const gradeObj = {
      userId: idtoken.user,
      scoreGiven: scoreClamped,
      scoreMaximum: 10,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded"
    };

    // Try to get line item from token first
    let lineItemId = idtoken?.platformContext?.endpoint?.lineitem;
    
    console.log("Initial lineItemId:", lineItemId);

    // If no line item in token, try to find or create one
    if (!lineItemId) {
      console.log("No lineItemId in token, fetching line items...");
      
      try {
        // Get all line items for this resource link
        const lineItemsResponse = await lti.Grade.getLineItems(idtoken, {
          resourceLinkId: true
        });
        
        console.log("Line items response:", lineItemsResponse);

        if (lineItemsResponse && lineItemsResponse.lineItems && lineItemsResponse.lineItems.length > 0) {
          // Use the first line item
          lineItemId = lineItemsResponse.lineItems[0].id;
          console.log("Using existing lineItemId:", lineItemId);
        } else {
          // Create a new line item
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
        console.error("Error getting/creating line item:", lineItemError);
        // If we can't get/create line item, try submitting without it
        // Some platforms allow this
      }
    }

    // Submit the score
    console.log("Submitting score to lineItemId:", lineItemId);
    const result = await lti.Grade.submitScore(idtoken, lineItemId, gradeObj);
    
    console.log("Grade submission result:", result);
    console.log("=== Grade Update Success ===");

    return res.json({ 
      ok: true, 
      score: scoreClamped,
      attempts: attempts,
      lineItemId: lineItemId
    });

  } catch (err) {
    console.error("=== Grade Update Error ===");
    console.error("Error details:", err);
    console.error("Error stack:", err.stack);
    return res.status(500).json({ 
      error: err?.message || String(err),
      details: err.stack
    });
  }
});

// 5) Start then register platform
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
