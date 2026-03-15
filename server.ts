import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import { google } from "googleapis";
import fs from "fs/promises";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const CONVERSATIONS_FILE = path.resolve(process.cwd(), "conversations.json");

  // Ensure storage file exists
  try {
    await fs.access(CONVERSATIONS_FILE);
    console.log(`Conversations file found at: ${CONVERSATIONS_FILE}`);
  } catch {
    console.log(`Creating new conversations file at: ${CONVERSATIONS_FILE}`);
    await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify([]));
  }

  const getOAuth2Client = (req: express.Request) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    
    // Use APP_URL if provided, otherwise construct from request
    const redirectUri = process.env.APP_URL 
      ? `${process.env.APP_URL.replace(/\/$/, '')}/auth/callback` 
      : `${protocol}://${host}/auth/callback`;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment variables.");
    }

    return new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri
    );
  };

  // API routes
  app.get("/api/auth/url", (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res.status(400).json({ 
        error: "Google Client ID is not configured. Please set GOOGLE_CLIENT_ID in the environment variables." 
      });
    }

    const scopes = [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ];

    const client = getOAuth2Client(req);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });

    res.json({ url });
  });

  app.get("/api/conversations", async (req, res) => {
    try {
      const data = await fs.readFile(CONVERSATIONS_FILE, "utf-8");
      res.json(JSON.parse(data));
    } catch (error: any) {
      console.error("Failed to load conversations:", error);
      res.status(500).json({ error: "Failed to load conversations", details: error.message });
    }
  });

  app.get("/api/conversations/download", async (req, res) => {
    try {
      res.download(CONVERSATIONS_FILE, "conversations.json");
    } catch (error: any) {
      console.error("Failed to download conversations file:", error);
      res.status(500).json({ error: "Failed to download file", details: error.message });
    }
  });

  app.post("/api/conversations", async (req, res) => {
    try {
      const newConv = req.body;
      const data = await fs.readFile(CONVERSATIONS_FILE, "utf-8");
      const conversations = JSON.parse(data);
      
      // Update if exists, else add
      const index = conversations.findIndex((c: any) => c.id === newConv.id);
      if (index !== -1) {
        conversations[index] = newConv;
      } else {
        conversations.push(newConv);
      }

      await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
      res.json({ success: true });
    } catch (error: any) {
      console.error("Failed to save conversation:", error);
      res.status(500).json({ error: "Failed to save conversation", details: error.message });
    }
  });

  app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    try {
      const client = getOAuth2Client(req);
      const { tokens } = await client.getToken(code as string);
      // In a real app, store tokens in session/db
      // For this demo, we'll just send a success message
      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', tokens: ${JSON.stringify(tokens)} }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (error) {
      res.status(500).send("Authentication failed");
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
