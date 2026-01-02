require("dotenv").config();

const path = require("path");
const express = require("express");
const lti = require("ltijs").Provider;
const jwt = require("jsonwebtoken");

// In-memory token cache (for production, consider Redis)
const tokenCache = new Map();

// Track cumulative scores per user session
const userScores = new Map(); // key: platform-course-activity-user, value: { score, attempts }

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

// Debug endpoint to check/reset user scores
lti.app.get("/debug/scores", (req, res) => {
  const scores = {};
  userScores.forEach((value, key) => {
    scores[key] = value;
  });
  res.json({
    activeScores: userScores.size,
    scores: scores,
    message: "Scores are tracked per platform-course-activity-user combination",
    resetInfo: "To reset: POST to /debug/reset-score?key=<full-key>"
  });
});

lti.app.post("/debug/reset-score", (req, res) => {
  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ 
      error: "key required",
      example: "POST /debug/reset-score?key=https://quizgametest.moodlecloud.com-9-3-4"
    });
  }
  if (userScores.has(key)) {
    userScores.delete(key);
    return res.json({ ok: true, message: `Score reset for key ${key}` });
  }
  return res.json({ ok: false, message: `No score found for key ${key}` });
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
  <style>
    body { margin: 0; padding: 0; overflow: hidden; }
    iframe { border: none; }
  </style>
</head>
<body>
  <iframe
    src="/game/index.html?ltik=${encodeURIComponent(ltik)}"
    style="width:100vw;height:100vh;border:none;"
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

    const scoreFromRequest = Number(req.body.score || 0);
    const attemptsFromRequest = Number(req.body.attempts || 1);
    const isExit = req.body.isExit || false;
    
    // Create unique key per platform + course + activity + user
    const userId = idtoken.user;
    const contextId = idtoken.platformContext?.context?.id || 'default';
    const resourceId = idtoken.platformContext?.resource?.id || 'default';
    const platformUrl = idtoken.iss || idtoken.platformUrl;
    
    // Unique key: platform-course-activity-user
    const scoreKey = `${platformUrl}-${contextId}-${resourceId}-${userId}`;
    
    console.log("Score key:", scoreKey);
    console.log("Is Exit:", isExit);
    console.log("  - Platform:", platformUrl);
    console.log("  - Course:", contextId);
    console.log("  - Activity:", resourceId);
    console.log("  - User:", userId);
    
    // Get or initialize user's cumulative data for THIS specific activity
    if (!userScores.has(scoreKey)) {
      userScores.set(scoreKey, { score: 0, attempts: 0 });
      console.log("Initialized new score tracking for this activity instance");
    }
    
    const userData = userScores.get(scoreKey);
    
    // Only increment if NOT an exit action
    if (!isExit) {
      userData.score += scoreFromRequest;
      userData.attempts += attemptsFromRequest;
      console.log("Incremented score and attempts");
    } else {
      console.log("Exit action - not incrementing score/attempts");
    }
    
    const scoreMaximum = 100;
    // Cap the score at maximum
    const cumulativeScore = Math.min(userData.score, scoreMaximum);
    const totalAttempts = userData.attempts;

    console.log(`User ${userId} - Cumulative: ${cumulativeScore} correct out of ${totalAttempts} attempts`);
    console.log(`Submitting grade: ${cumulativeScore}/${scoreMaximum}`);

    // Build grade objects for both Score and Attempts
    const scoreGradeObj = {
      scoreGiven: cumulativeScore,
      scoreMaximum: scoreMaximum,
      activityProgress: cumulativeScore >= scoreMaximum ? "Completed" : "InProgress",
      gradingProgress: "FullyGraded",
      timestamp: new Date().toISOString(),
      comment: `Score: ${cumulativeScore} | Attempts: ${totalAttempts} | Accuracy: ${totalAttempts > 0 ? Math.round((cumulativeScore/totalAttempts)*100) : 0}%`
    };

    const attemptsGradeObj = {
      scoreGiven: totalAttempts,
      scoreMaximum: 100, // Arbitrary max for attempts
      activityProgress: "InProgress",
      gradingProgress: "FullyGraded",
      timestamp: new Date().toISOString(),
      comment: `Total attempts made`
    };

    console.log("Score grade object:", JSON.stringify(scoreGradeObj, null, 2));
    console.log("Attempts grade object:", JSON.stringify(attemptsGradeObj, null, 2));
    console.log("Token info for submission:");
    console.log("  - User:", idtoken.user);
    console.log("  - Platform:", idtoken.platformUrl);
    console.log("  - ClientId:", idtoken.clientId);

    // Get or create line items for Score and Attempts
    let scoreLineItemId = idtoken?.platformContext?.endpoint?.lineitem;
    let attemptsLineItemId = null;
    
    console.log("Initial lineItemId from token:", scoreLineItemId);

    // Get all line items for this resource
    try {
      const lineItemsResponse = await lti.Grade.getLineItems(idtoken, {
        resourceLinkId: true
      });
      
      console.log("Line items response:", lineItemsResponse);

      if (lineItemsResponse?.lineItems?.length > 0) {
        const items = lineItemsResponse.lineItems;
        console.log("Found line items:", items.map(i => ({ id: i.id, label: i.label, tag: i.tag })));
        
        // Find the main activity line item (the one WITHOUT a tag, or the first one)
        // This is the original "TestPOC1" column
        if (!scoreLineItemId) {
          // Try to find line item without tag (this is usually the main activity grade)
          const mainItem = items.find(item => !item.tag || item.tag === 'score');
          if (mainItem) {
            scoreLineItemId = mainItem.id;
            console.log("Found main activity lineItemId:", scoreLineItemId);
          } else {
            // If no untagged item found, use the first one that's not "attempts"
            const nonAttemptsItem = items.find(item => item.tag !== 'attempts');
            if (nonAttemptsItem) {
              scoreLineItemId = nonAttemptsItem.id;
              console.log("Using first non-attempts lineItemId:", scoreLineItemId);
            }
          }
        }
        
        // Find the Attempts line item
        const attemptsItem = items.find(item => item.tag === 'attempts');
        if (attemptsItem) {
          attemptsLineItemId = attemptsItem.id;
          console.log("Found existing Attempts lineItemId:", attemptsLineItemId);
        }
      }

      // If still no score line item found, we have a problem
      if (!scoreLineItemId) {
        console.error("CRITICAL: No score line item found in token or line items list");
        console.error("Available line items:", lineItemsResponse?.lineItems);
        return res.status(400).json({ 
          error: "No line item available for score submission. This activity may not be configured for grading."
        });
      }

      // Create Attempts line item if it doesn't exist
      if (!attemptsLineItemId) {
        console.log("Creating Attempts line item...");
        const created = await lti.Grade.createLineItem(idtoken, {
          scoreMaximum: 100,
          label: "Attempts",
          tag: "attempts",
          resourceLinkId: idtoken.platformContext?.resource?.id
        });
        attemptsLineItemId = created.id;
        console.log("Created Attempts lineItemId:", attemptsLineItemId);
      }
    } catch (lineItemError) {
      console.error("Error with line items:", lineItemError.message);
      console.error("Full error:", lineItemError);
      
      // If we have a lineitem from token, continue with that
      if (!scoreLineItemId) {
        return res.status(500).json({ 
          error: "Failed to retrieve line items: " + lineItemError.message
        });
      }
    }

    // Final check before submission
    if (!scoreLineItemId) {
      console.error("No scoreLineItemId available - cannot submit grade");
      return res.status(400).json({ 
        error: "No line item available for score submission"
      });
    }

    // Submit the scores to both line items
    console.log("Submitting Score to lineItemId:", scoreLineItemId);
    console.log("Submitting Attempts to lineItemId:", attemptsLineItemId);
    
    try {
      // Submit Score
      const scoreResult = await lti.Grade.submitScore(idtoken, scoreLineItemId, scoreGradeObj);
      console.log("Score submission result:", scoreResult);

      // Submit Attempts (if line item was created)
      let attemptsResult = null;
      if (attemptsLineItemId) {
        attemptsResult = await lti.Grade.submitScore(idtoken, attemptsLineItemId, attemptsGradeObj);
        console.log("Attempts submission result:", attemptsResult);
      } else {
        console.log("Attempts line item not available, skipping attempts submission");
      }
      
      console.log("=== Grade Update Success ===");

      return res.json({ 
        ok: true, 
        score: cumulativeScore,
        attempts: totalAttempts,
        scoreMaximum: scoreMaximum,
        scoreLineItemId: scoreLineItemId,
        attemptsLineItemId: attemptsLineItemId,
        results: {
          score: scoreResult,
          attempts: attemptsResult
        }
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
