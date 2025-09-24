import express from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer } from "vite";
import simpleGit from "simple-git";
import "dotenv/config";

const app = express();
app.use(express.text());
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    throw new Error("No OpenAI API key provided.");
}

// Configure Vite middleware for React client
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "custom",
});
app.use(vite.middlewares);

// Git configuration from environment variables
const NOTES_REPO_URL = process.env.NOTES_REPO_URL;
const NOTES_REPO_BRANCH = process.env.NOTES_REPO_BRANCH || 'agent';
const GIT_USERNAME = process.env.GIT_USERNAME || 'davdma-bot';
const GIT_EMAIL = process.env.GIT_EMAIL || 'davidma.inspire+bot@email.com';

// Repo access via SSH

// Initialize Git repository for notes
const notesDir = path.join(process.cwd(), 'notes');
let git = simpleGit();
let isGitConfigured = false;

// TODO: In the future use SSH keys from AWS for max security

// Setup Git repository
async function setupGitRepository() {
  if (!NOTES_REPO_URL) {
    throw new Error("Missing remote URL");
  }

  if (!NOTES_REPO_URL.startsWith("git@github")) {
    throw new Error("Repo URL must be by SSH (git@github...)");
  }

  // Create authentication URL if token is provided
  // The remote should not have the token, will inject it using global config
  const repoUrl = NOTES_REPO_URL;
  console.log('Setting up remote Git repository...');
  // Check if notes directory already exists and has a git repo
  if (fs.existsSync(notesDir) && fs.existsSync(path.join(notesDir, '.git'))) {
    // validate that it points to the right remote
    console.log('Existing Git repository found, validating remote.');
    git = simpleGit(notesDir);
    const cur_remote = (await git.remote(['get-url', 'origin'])).trim();
    if (cur_remote !== repoUrl) {
      throw new Error(`Existing repo remote ${cur_remote} is different from ${NOTES_REPO_URL}`);
    }
  } else {
    // Remove existing notes directory if it exists without git
    if (fs.existsSync(notesDir)) {
      fs.rmSync(notesDir, { recursive: true, force: true });
    }
    // Clone the repository
    console.log(`Cloning repository from ${NOTES_REPO_URL}...`);
    // inject token - may need to think through this part
    await simpleGit().clone(repoUrl, notesDir);
    git = simpleGit(notesDir);

    // Checkout the specified branch
    if (NOTES_REPO_BRANCH !== 'main' && NOTES_REPO_BRANCH !== 'master') {
      try {
        await git.checkout(NOTES_REPO_BRANCH);
      } catch (branchError) {
        console.log(`Branch ${NOTES_REPO_BRANCH} doesn't exist, creating it...`);
        await git.checkoutLocalBranch(NOTES_REPO_BRANCH);
        // set upstream for pushing
        await git.push('origin', NOTES_REPO_BRANCH, ['-u']);
      }
    }
  }

  // Configure git user
  await git.addConfig('user.name', GIT_USERNAME);
  await git.addConfig('user.email', GIT_EMAIL);

  // Pull latest changes
  await git.pull('origin', NOTES_REPO_BRANCH);
  console.log('Git repository configured successfully!');
  isGitConfigured = true;
}

// Initialize Git repository on startup
await setupGitRepository();

// Tool handler functions
async function writeNotes(content) {
  // for agent notes save markdown by date
  try {
    if (!isGitConfigured) {
      throw new Error('Git repository is not properly configured');
    }

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const fileName = `${today}.md`;
    const filePath = path.join(notesDir, fileName);

    // Pull latest changes from remote repository
    console.log('Pulling latest changes...');
    await git.pull('origin', NOTES_REPO_BRANCH);

    // Append content to today's file
    const timestamp = new Date().toLocaleTimeString();
    const entry = `\n## ${timestamp}\n${content}\n`;

    if (fs.existsSync(filePath)) {
      fs.appendFileSync(filePath, entry);
    } else {
      fs.writeFileSync(filePath, `# Notes for ${today}${entry}`);
    }

    // Git operations
    await git.add(filePath);
    const commitMessage = `Add notes for ${today} at ${timestamp}`;
    await git.commit(commitMessage);

    let pushResult = null;
    try {
      console.log('Pushing changes to remote...');
      pushResult = await git.push('origin', NOTES_REPO_BRANCH);
      console.log('Successfully pushed to remote repository');
    } catch (pushError) {
      console.error('Failed to push to remote:', pushError.message);
      // Don't fail the entire operation if push fails
      pushResult = { error: pushError.message };
    }

    return {
      success: true,
      message: `Notes saved to ${fileName}`,
      filepath: filePath,
      gitStatus: {
        committed: true,
        pushed: pushResult && !pushResult.error,
        pushError: pushResult?.error || null
      }
    };
  } catch (error) {
    console.error('Error saving notes:', error);
    return {
      success: false,
      message: `Failed to save notes: ${error.message}`
    };
  }
}

async function fetchNotesByDate(timeframe = 'all') {
  // For fetching notes fetch by recently committed or changed in git history
  const valid = ["all", "today", "week"];
  try {
    if (!isGitConfigured) {
      throw new Error('Git repository is not properly configured');
    }
    if (!valid.includes(timeframe)) {
      throw new Error(`Invalid timeframe: ${timeframe}. Must be one of ${valid.join(", ")}`);
    }

    // Pull latest changes from remote repository
    console.log('Pulling latest changes before fetching notes...');
    await git.pull('origin', NOTES_REPO_BRANCH);

    // for nested docs inside of docusaurus may need to change this logic
    const files = fs.readdirSync(notesDir).filter(file => file.endsWith('.md'));

    if (files.length === 0) {
      return {
        success: true,
        message: 'No notes found',
        notes: []
      };
    }

    // Get content and last commit date for each file
    const notes = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(notesDir, file);
        const content = fs.readFileSync(filePath, 'utf8');

        // use git log to get last commit date
        const log = await git.log({ file: filePath, n: 1 });
        const lastCommitDate = log.latest ? log.latest.date : null;

        return {
          filename: file,
          content,
          lastCommitDate
        }
      })
    )

    // Filter out null (uncommitted) and sort by commit date
    let sortedNotes = notes.filter(note => note.lastCommitDate).sort((a, b) => new Date(b.lastCommitDate) - new Date(a.lastCommitDate));

    // Apply timeframe filtering
    if (timeframe === 'today') {
      const today = new Date().toDateString();
      sortedNotes = sortedNotes.filter(note => {
        return new Date(note.lastCommitDate).toDateString() === today;
      });
    } else if (timeframe === 'week') {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      sortedNotes = sortedNotes.filter(note => new Date(note.lastCommitDate) >= sevenDaysAgo);
    }
    return {
      success: true,
      message: `Found ${sortedNotes.length} note file(s) for timeframe: ${timeframe}`,
      notes: sortedNotes,
      totalFiles: files.length
    };
  } catch (error) {
    console.error('Error fetching notes:', error);
    return {
      success: false,
      message: `Failed to fetch notes: ${error.message}`
    };
  }
}

async function fetchNotesByGrep(term) {
  // fetch notes by grepping, for now fetches entire matched file
  try {
    if (!isGitConfigured) {
      throw new Error('Git repository is not properly configured');
    }
    if (!term || typeof term !== 'string') {
      throw new Error('Search term must be a non-empty string');
    }

    console.log(`Searching notes with git grep for term: "${term}"...`);

    // Run git grep across markdown files
    const grepResult = await git.grep(term, ['--', '*.md', '*.mdx']);

    if (!grepResult.paths || grepResult.paths.size === 0) {
      return {
        success: true,
        message: `No notes found matching "${term}"`,
        notes: []
      };
    }

    // Convert Set to Array for iteration
    const files = Array.from(grepResult.paths);

    // Collect results
    const notes = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(notesDir, file);
        const content = fs.readFileSync(filePath, 'utf8');

        // Get last commit date for file
        const log = await git.log({ file: filePath, n: 1 });
        const lastCommitDate = log.latest ? log.latest.date : null;

        // Extract matches from grep results
        const matches = grepResult.results[file] || [];

        return {
          filename: file,
          content,
          lastCommitDate,
          matches  // [{ line, path, preview }]
        };
      })
    );

    // Sort newest first
    let sortedNotes = notes
      .filter(note => note.lastCommitDate)
      .sort((a, b) => new Date(b.lastCommitDate) - new Date(a.lastCommitDate));

    return {
      success: true,
      message: `Found ${sortedNotes.length} note file(s) matching "${term}"`,
      notes: sortedNotes,
      totalFiles: files.length
    };
  } catch (error) {
    console.error('Error fetching notes by grep:', error);
    return {
      success: false,
      message: `Failed to fetch notes by grep: ${error.message}`
    };
  }
}

// TODO: Tool call that asks Claude Code to fetch selectively from notes (in plan mode)
// Set git tools server side for safety
const sessionConfig = JSON.stringify({
  session: {
    type: "realtime",
    model: "gpt-realtime",
    instructions: "You are a teacher that helps the user learn across a wide range of topics and assist in taking notes in a markdown Git repository",
    audio: {
      output: {
        voice: "marin",
      },
    },
    tools: [
      {
        type: "function",
        name: "write_notes",
        description: "Write notes to the Git repository with automatic commit and push",
        parameters: {
          type: "object",
          strict: true,
          properties: {
            content: {
              type: "string",
              description: "The content to write to the notes file"
            }
          },
          required: ["content"]
        }
      },
      {
        type: "function",
        name: "fetch_notes_by_date",
        description: "Fetch notes by time range from the Git repository",
        parameters: {
          type: "object",
          properties: {
            timeframe: {
              type: "string",
              description: "Time range for notes",
              enum: ["all", "week", "today"]
            }
          },
          required: ['timeframe']
        }
      },
      {
        type: "function",
        name: "fetch_notes_by_grep",
        description: "Fetch notes by grepping from the Git repository",
        parameters: {
          type: "object",
          properties: {
            term: {
              type: "string",
              description: "Search term for grepping"
            }
          },
          required: ["term"]
        }
      }
    ],
    tool_choice: "auto"
  },
});

// All-in-one SDP request (experimental)
app.post("/session", async (req, res) => {
  const fd = new FormData();
  console.log(req.body);
  fd.set("sdp", req.body);
  fd.set("session", sessionConfig);

  const r = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      "OpenAI-Beta": "realtime=v1",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: fd,
  });
  const sdp = await r.text();
  console.log(sdp);

  // Send back the SDP we received from the OpenAI REST API
  res.send(sdp);
});

// API route for ephemeral token generation
app.get("/token", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: sessionConfig,
      },
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Handle tool calls from the GPT model
app.post("/tools", express.json(), async (req, res) => {
  try {
    const { name, parameters } = req.body;

    let result;
    switch (name) {
      case 'write_notes':
        result = await writeNotes(parameters.content);
        break;
      case 'fetch_notes_by_date':
        result = await fetchNotesByDate(parameters.timeframe);
        break;
      case 'fetch_notes_by_grep':
        result = await fetchNotesByGrep(parameters.term);
        break;
      default:
        result = {
          success: false,
          message: `Unknown tool: ${name}`
        };
    }

    res.json(result);
  } catch (error) {
    console.error("Tool execution error:", error);
    res.status(500).json({
      success: false,
      message: `Tool execution failed: ${error.message}`
    });
  }
});

// Render the React client
app.use("*", async (req, res, next) => {
  const url = req.originalUrl;

  try {
    const template = await vite.transformIndexHtml(
      url,
      fs.readFileSync("./client/index.html", "utf-8"),
    );
    const { render } = await vite.ssrLoadModule("./client/entry-server.jsx");
    const appHtml = await render(url);
    const html = template.replace(`<!--ssr-outlet-->`, appHtml?.html);
    res.status(200).set({ "Content-Type": "text/html" }).end(html);
  } catch (e) {
    vite.ssrFixStacktrace(e);
    next(e);
  }
});

app.listen(port, () => {
  console.log(`Express server running on *:${port}`);
});
