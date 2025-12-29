require("dotenv").config();

const path = require("path");
const express = require("express");
const lti = require("ltijs").Provider;

// --------------------
// 1) LTI setup (MongoDB Atlas)
// --------------------
lti.setup(
  process.env.LTI_ENCRYPTION_KEY,
  { url: process.env.LTI_DB_URL },
  {
    appRoute: "/",
    loginRoute: "/login",
    keysetRoute: "/keys",
    cookies: { secure: true, sameSite: "none" },
    devMode: false
  }
);

// --------------------
// 2) Middleware + static files
// --------------------
lti.app.use(express.json());
lti.app.use(express.static(path.join(__dirname, "..", "public")));

lti.app.get("/health", (req, res) => res.send("OK"));

// --------------------
// 3) LTI launch page (no redirect loop)
// --------------------
lti.onConnect((token, req, res) => {
  const ltik = req.query.ltik || "";
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

// --------------------
// 4) Helper: get a Grade API object in a version-safe way
// --------------------
function getGradeApi(token) {
  // Variant A: GradeService(token) function exists
  if (typeof lti.GradeService === "function") return lti.GradeService(token);

  // Variant B: Grade(token) function exists (not constructor)
  if (typeof lti.Grade === "function") return lti.Grade(token);

  // Variant C: Grade is a constructor (rare in your case)
  if (typeof lti.Grade === "object" && typeof lti.Grade.default === "function") {
    return new lti.Grade.default(token);
  }

  return null;
}

// --------------------
// 5) Grade update endpoint
// --------------------
lti.app.post("/api/update", async (req, res) => {
  try {
    const token = res.locals.token;
    if (!token) return res.status(401).send("Missing/invalid ltik");

    const score = Number(req.body.score || 0);
    const attempts = Number(req.body.attempts || 0);

    const grade = getGradeApi(token);
    if (!grade) {
      return res
        .status(500)
        .send("Grade API not available in this Ltijs build (no GradeService/Grade).");
    }

    // ---- Find or create line item "Score"
    let scoreLineItem = null;

    // Some Ltijs builds provide getLineItemByLabel, others use getLineItems + filter
    if (typeof grade.getLineItemByLabel === "function") {
      scoreLineItem = await grade.getLineItemByLabel("Score");
    } else if (typeof grade.getLineItems === "function") {
      const items = await grade.getLineItems();
      scoreLineItem = items.find((li) => li.label === "Score") || null;
    }

    if (!scoreLineItem && typeof grade.createLineItem === "function") {
      scoreLineItem = await grade.createLineItem({
        label: "Score",
        scoreMaximum: 10,
        resourceId: "score"
      });
    }

    if (!scoreLineItem || !scoreLineItem.id) {
      return res.status(500).send("Could not create/find Score line item.");
    }

    // ---- Submit score
    if (typeof grade.submitScore !== "function") {
      return res.status(500).send("submitScore is not available on Grade API.");
    }

    await grade.submitScore(scoreLineItem.id, {
      userId: token.user,
      scoreGiven: score,
      scoreMaximum: 10,
      comment: `Attempts: ${attempts}`,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded"
    });

    return res.json({ ok: true, posted: { score, attempts } });
  } catch (e) {
    return res.status(500).send(String(e));
  }
});

// --------------------
// 6) Start then register Moodle platform
// --------------------
(async () => {
  try {
    const port = process.env.PORT || 3000;

    await lti.deploy({ port });
    console.log("Running on", port);

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

    console.log("Platform registered.");
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();
