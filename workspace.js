const fs = require("fs");
const { Octokit } = require("@octokit/action");
const OpenAI = require("openai");

const openai = new OpenAI();
const octokit = new Octokit();

// Get the issue number from the command line arguments
const issueNumber = process.argv[2];
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");

(async () => {
  // Log the issue number to the console
  console.log(`GitHub issue - #${issueNumber}`);

  const assistant = await openai.beta.assistants.create({
    model: "gpt-4-turbo",
    name: "Smol GitHub Workspace",
    instructions:
      "You are an expert programmer. You are asked to provide a solution to the given issue using the provided tools.",
    tools: [
      { type: "code_interpreter" },
      {
        type: "function",
        function: {
          name: "list_files",
          description: "Get a list of all available files in a repository",
        },
      },
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read the contents of a file in a repository",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "The path of the file to read - ./path/to/file",
              },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "update_file",
          description: "Update the contents of a file in a repository",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "The path of the file to update - ./path/to/file",
              },
              content: {
                type: "string",
                description: "The new content for the file",
              },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "create_file",
          description: "Create a new file in a repository",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "The path for the new file - ./path/to/file",
              },
              content: {
                type: "string",
                description: "The content for the new file",
              },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "delete_file",
          description: "Delete a file from a repository",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "The path of the file to delete - ./path/to/file",
              },
            },
            required: ["path"],
          },
        },
      },
    ],
  });

  const issue = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  const task = `Issue: ${issue.data.title}\n\n${issue.data.body}`;
  const thread = await openai.beta.threads.create();
  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: task,
  });
  let run = await openai.beta.threads.runs.createAndPoll(thread.id, {
    assistant_id: assistant.id,
  });
  return handleRunStatus(thread, run);
})();

/**
 * Handles the status of the run and returns the messages in the thread
 * @param {OpenAI.Beta.Thread} thread - The thread object
 * @param {OpenAI.Beta.Threads.Run} run - The run object
 * @returns {Promise<OpenAI.Beta.Threads.Message[]>} - The messages in the thread
 */
const handleRunStatus = async (thread, run) => {
  // If the run is completed, return the messages in the thread, we're good! 🎉
  if (run.status === "completed") {
    let messages = await openai.beta.threads.messages.list(thread.id);
    octokit.log.info(JSON.stringify(messages.data));
    return messages.data;
  }

  // If the run requires action, send the tool outputs
  if (run.status === "requires_action") {
    octokit.log.info(JSON.stringify(run.status));
    return await handleRequiresAction(thread, run);
  }

  octokit.log.error("Run did not complete:", run);
};

/**
 * Handles the requires action status of the run
 * @param {OpenAI.Beta.Thread} thread - The thread object
 * @param {OpenAI.Beta} run - The run object
 * @returns {Promise<OpenAI.Beta.Threads.Message[] | undefined>} - The messages in the thread or undefined
 */
const handleRequiresAction = async (thread, run) => {
  // Ensure that there are tools that require outputs
  if (!run.required_action?.submit_tool_outputs?.tool_calls) return;

  const toolOutputs = [];
  for (const tool of run.required_action.submit_tool_outputs.tool_calls) {
    if (tool.function.name === "list_files") {
      toolOutputs.push({
        tool_call_id: tool.id,
        output: "- index.html",
      });
    } else if (tool.function.name === "read_file") {
      toolOutputs.push({
        tool_call_id: tool.id,
        output: fs.readFileSync(
          JSON.parse(tool.function.arguments).path,
          "utf-8"
        ),
      });
    }
    // Handle update_file, create_file, and delete_file actions
    else if (tool.function.name === "update_file") {
      const args = JSON.parse(tool.function.arguments);
      fs.writeFileSync(args.path, args.content, "utf-8");
      console.log(`Updating file at path: ${args.path}`);
      toolOutputs.push({
        tool_call_id: tool.id,
        output: "File updated successfully",
      });
    } else if (tool.function.name === "create_file") {
      const args = JSON.parse(tool.function.arguments);
      fs.writeFileSync(args.path, args.content, "utf-8");
      console.log(`Creating new file at path: ${args.path}`);
      toolOutputs.push({
        tool_call_id: tool.id,
        output: "File created successfully",
      });
    } else if (tool.function.name === "delete_file") {
      const args = JSON.parse(tool.function.arguments);
      fs.unlinkSync(args.path);
      console.log(`Deleting file at path: ${args.path}`);
      toolOutputs.push({
        tool_call_id: tool.id,
        output: "File deleted successfully",
      });
    }
  }

  // Submit all tool outputs at once after collecting them in a list
  if (toolOutputs.length > 0) {
    run = await openai.beta.threads.runs.submitToolOutputsAndPoll(
      thread.id,
      run.id,
      { tool_outputs: toolOutputs }
    );
    octokit.log.info(
      "Tool outputs submitted successfully.",
      JSON.stringify(toolOutputs)
    );
  } else {
    octokit.log.info("No tool outputs to submit.");
  }

  // Check status after submitting tool outputs
  return handleRunStatus(thread, run);
};
