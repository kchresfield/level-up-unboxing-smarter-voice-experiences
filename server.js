import OpenAI from "openai";
import 'dotenv/config';
import express from 'express';
import ExpressWs from 'express-ws';
import tools from './function-manifest.js';

import twilio from 'twilio';
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
ExpressWs(app);

const PORT = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const prompt = `You are assisting a caller. 
ALWAYS respond to the caller with a short message FIRST.
Wait for your response to be delivered. 
THEN, IMMEDIATELY call the 'send-message' function. 
You MUST call this function every time, even after a single response.
Keep answers short and simple, no more than 10 words.
You do not need to mention that you are sending a message.`

let assist_id;

async function assist() {
  const assistant = await openai.beta.assistants.create({
    name: "Level Up, Unboxing",
    instructions: prompt,
    tools: tools,
    model: "gpt-4o"
  })
  assist_id = assistant.id;
  console.log("assistant data: ", assistant.tools[0].function)
}
assist();

app.ws('/connection', (ws) => {
  try {
    /////////// Function declaration zone ///////////
    async function sendMessage(phoneNumber) {
      const message = await client.messages.create({
        body: ws.response,
        from: process.env.TWILIO_FROM_NUMBER,
        to: phoneNumber,
      });
      console.log(message);
    }
    ///////////////////////////////////////////////////////


    ws.on('message', async data => { // Incoming message from CR
      const msg = JSON.parse(data);
      console.log("Incoming orcestration: ", msg);

      if (msg.type === "setup") { // Initial call connection
        /**
         * Create a new thread
         * https://platform.openai.com/docs/assistants/deep-dive#managing-threads-and-messages
         * 
         * Add the incoming caller and threadID to the ws object
         */

        const thread = await openai.beta.threads.create();
        ws.caller = msg.from;
        ws.threadId = thread.id;
        console.log(ws.threadId)

      } else if (msg.type === "prompt") { // A user begins speaking
        // Add their question to the thread with the role "user"
        let addMsgToThread = await openai.beta.threads.messages.create(ws.threadId, {
          role: "user",
          content: msg.voicePrompt
        });
        console.log("Message added to thread: ", { id: addMsgToThread.id, object: addMsgToThread.object, content: addMsgToThread.content[0].text })

        /**
         * Run the thread that was just created
         * https://platform.openai.com/docs/assistants/deep-dive#runs-and-run-steps
         */

        const run = openai.beta.threads.runs.stream(ws.threadId, {
          assistant_id: assist_id
        })

        let hasSentText = false; // A flag to know if the response was said to the caller

        /**
         * Learn more about Assistant stream events here
         * https://platform.openai.com/docs/api-reference/assistants-streaming/events
         * 
         * textDone: https://platform.openai.com/docs/api-reference/realtime-server-events/response/text/done
         * toolCallDone: https://platform.openai.com/docs/assistants/tools/function-calling
         */
        run.on('textDone', (textDone, snapshot) => {
          // Send response from OpenAI model to Conversation Relay to be read back to the caller
          ws.send(
            JSON.stringify({
              type: "text",
              token: textDone.value
            })
          )
          console.log("textDone: ", textDone)
          ws.response = textDone.value
          hasSentText = true;
        })
          .on('toolCallDone', async (toolCallDone) => {
            console.log("tooldCallDone: ", toolCallDone)
            if (!hasSentText) { // Check if the audio has been sent to Conversation Relay
              console.log("Tool call received before text! Waiting...");
              await new Promise(resolve => setTimeout(resolve, 200)); // Small delay
            }

            if (toolCallDone.function.name === "send-message") { // If the function is triggered by OpenAI send the message
              sendMessage(ws.caller)
            }
          })
      }
    });

    ws.on("close", async () => {
      // delete assistant
      const response = await openai.beta.assistants.del(assist_id);
      console.log("WebSocket connection closed and OpenAI assistant deleted");
    });

  } catch (err) {
    console.error(err);
  }
});


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
