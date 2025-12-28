require("dotenv").config();

const path = require("path");
const express = require("express");
const { Provider } = require("ltijs");

const app = express();
app.use(express.json());

// POC DB (Render can write to /tmp)
const DB_URL = process.env.LTI_DB_URL || "sqlite:///tmp/lti.db";

// LTI provider
const lti = new Provider(process.env.LTI_ENCRYPTION_KEY, DB_URL, {
  appRoute: "/",
  loginRoute: "/login",
  keysetRoute: "/keys",
  cookies: { secure: true, sameSite: "none" }
});

// Launch HTML (loads the game in an iframe)
function launchHtml(user) {
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Godot LTI POC</title>
</head>
<body style="font-family:sans-serif;margin:16px;">
  <h2>Godot LTI POC</h2>
  <div style="margin-bottom:12px;">
    Logged in as: <b>${user.name}</b> (${user.email})
  </div>

  <p>Game loads below:</p>

  <iframe
    src="/game/index.html"
    style="width:960px;height:600px;border:1px solid #ccc;border-radius:8px;"
  ></iframe>

  <script>
    // Godot Web calls this on every click
    window.updateToMoodle = async function(score, attempts, isExit) {
      const r = await fetch("/api/update", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ score, attempts, isExit: !!isExit })
      });

      if (!r.ok) console.warn("Update failed:", await r.text());
      if (isExit) window.close();
    };
  </script>
</body>
</html>`;
}

function getUser(token) {
  const email = token?.userInfo?.email || token?.email || "unknown@example.com";
  const name = token?.userInfo?.name || token?.name || "Unknown User";
  return { email, name, userId: token?.user || token?.sub };
}

(async () => {
  await lti.setup();

  // ✅ We will add MoodleCloud platform registration here in a later step.
  // await lti.registerPlatform({...});

  // Serve static files from /public
  app.use(express.static(path.join(__dirname, "..", "public")));

  // LTI launch: Moodle sends user here
  lti.onConnect(async (token, req, res) => {
    const user = getUser(token);
    res.send(launchHtml(user));
  });

  // API: post score + attempts back to Moodle gradebook
  app.post("/api/update", lti.authenticate(), async (req, res) => {
    try {
      const token = res.locals.token;

      const score = Number(req.body.score || 0);
      const attempts = Number(req.body.attempts || 0);

      const grade = lti.GradeService(token);

      // Two grade columns (LineItems): Score + Attempts
      const scoreLineItem =
        (await grade.getLineItemByLabel("Score")) ||
        (await grade.createLineItem({
          label: "Score",
          scoreMaximum: 10,
          resourceId: "score"
        }));

      const attemptsLineItem =
        (await grade.getLineItemByLabel("Attempts")) ||
        (await grade.createLineItem({
          label: "Attempts",
          scoreMaximum: 1000,
          resourceId: "attempts"
        }));

      // Post Score
      await grade.submitScore(scoreLineItem.id, {
        userId: token.user,
        scoreGiven: score,
        scoreMaximum: 10,
        comment: `Attempts: ${attempts}`,
        activityProgress: "Completed",
        gradingProgress: "FullyGraded"
      });

      // Post Attempts (as second column)
      await grade.submitScore(attemptsLineItem.id, {
        userId: token.user,
        scoreGiven: attempts,
        scoreMaximum: 1000,
        comment: `Score: ${score}`,
        activityProgress: "Completed",
        gradingProgress: "FullyGraded"
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(500).send(String(e));
    }
  });

  await lti.deploy({ app, serverless: true });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("Running on", port));
})();
