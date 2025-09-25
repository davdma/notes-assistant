import { useEffect, useRef, useState } from "react";
import logo from "/assets/openai-logomark.svg";
import EventLog from "./EventLog";
import SessionControls from "./SessionControls";
import ToolPanel from "./ToolPanel";

export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [dataChannel, setDataChannel] = useState(null);
  const peerConnection = useRef(null);
  const audioElement = useRef(null);
  const activeResponseId = useRef(null);

  async function startSession() {
    // Get a session token for OpenAI Realtime API
    const tokenResponse = await fetch("/token");
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.value;

    // Create a peer connection
    const pc = new RTCPeerConnection();

    // Set up to play remote audio from the model
    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => (audioElement.current.srcObject = e.streams[0]);

    // Add local audio track for microphone input in the browser
    const ms = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    pc.addTrack(ms.getTracks()[0]);

    // Set up data channel for sending and receiving events
    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    // Start the session using the Session Description Protocol (SDP)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime/calls";
    const model = "gpt-realtime";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });

    const sdp = await sdpResponse.text();
    const answer = { type: "answer", sdp };
    await pc.setRemoteDescription(answer);

    peerConnection.current = pc;
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
    }

    peerConnection.current.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    setIsSessionActive(false);
    setDataChannel(null);
    peerConnection.current = null;
  }

  // Send a message to the model
  function sendClientEvent(message) {
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();

      // send event before setting timestamp since the backend peer doesn't expect this field
      dataChannel.send(JSON.stringify(message));

      // if guard just in case the timestamp exists by miracle
      if (!message.timestamp) {
        message.timestamp = timestamp;
      }
      setEvents((prev) => [message, ...prev]);
    } else {
      console.error(
        "Failed to send message - no data channel available",
        message,
      );
    }
  }

  // Send a text message to the model
  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };

    sendClientEvent(event);
    if (activeResponseId.current) {
      sendClientEvent({ type: "response.cancel",
                        response_id: activeResponseId.current })
    }
    sendClientEvent({ type: "response.create" });
  }

  // Execute function call and send result back
  async function executeFunctionCall(callId, name, parameters) {
    try {
      console.log(`Executing function call: ${name}`, parameters);

      // Call the server's tool endpoint
      const response = await fetch('/tools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, parameters }),
      });

      const result = await response.json();
      console.log(`Function call result:`, result);

      // Send the function call output back to the API
      const outputEvent = {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result)
        }
      };

      sendClientEvent(outputEvent);
      if (activeResponseId.current) {
        sendClientEvent({ type: "response.cancel",
                          response_id: activeResponseId.current })
      }
      sendClientEvent({ type: "response.create" });

    } catch (error) {
      console.error('Function call execution error:', error);

      // Send error back to API
      const errorEvent = {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({
            success: false,
            message: `Function execution failed: ${error.message}`
          })
        }
      };

      sendClientEvent(errorEvent);
      sendClientEvent({ type: "response.create" });
    }
  }

  // Process server events and update transcript
  function processServerEvent(event) {
    // Handle tool call events
    if (event.type === 'response.done' && event.response.output?.[0]?.type === 'function_call') {
      // Tool call in progress
      try {
        const fcall = event.response.output[0];
        const params = JSON.parse(fcall.arguments);
        // TODO: add tool card to the Tool Panel to show it's being processed
        executeFunctionCall(fcall.call_id, fcall.name, params);
      } catch (parseError) {
        console.error('Failed to parse function arguments:', parseError);
      }
    }

    if (event.type === 'response.done') {
      // TODO: Cleanup or remove outdated tool cards after any assistant response
      // removeCompletedToolCards();
    }
  }

    // Handle assistant responses
    // if (event.type === 'response.output_text.delta') {
    //   const content = event.delta || '';
    //   setTranscript(prev => {
    //     const lastMessage = prev[prev.length - 1];
    //     if (lastMessage && lastMessage.role === 'assistant' && lastMessage.isStreaming) {
    //       // Update existing streaming message
    //       return prev.map((msg, idx) =>
    //         idx === prev.length - 1
    //           ? { ...msg, content: msg.content + content }
    //           : msg
    //       );
    //     } else {
    //       // Start new assistant message
    //       return [...prev, {
    //         id: crypto.randomUUID(),
    //         role: 'assistant',
    //         content: content,
    //         timestamp: new Date().toLocaleTimeString(),
    //         isStreaming: true
    //       }];
    //     }
    //   });
    // }

  // Attach event listeners to the data channel when a new one is created
  useEffect(() => {
    if (dataChannel) {
      // Append new server events to the list
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
        }
        // track active response lifecycle for manual interrupts
        if (event.type === "response.created") {
          activeResponseId.current = event.response.id;
        }
        if (event.type === "response.done" && event.response.status !== "in_progress") {
          activeResponseId.current = null;
        }
        setEvents((prev) => [event, ...prev]);
        processServerEvent(event);
      });

      // Set session active when the data channel is opened
      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
      });
    }
  }, [dataChannel]);

  return (
    <>
      <nav className="absolute top-0 left-0 right-0 h-16 flex items-center">
        <div className="flex items-center gap-4 w-full m-4 pb-2 border-0 border-b border-solid border-gray-200">
          <img style={{ width: "24px" }} src={logo} />
          <h1>David's Assistant</h1>
        </div>
      </nav>
      <main className="absolute top-16 left-0 right-0 bottom-0">
        <section className="absolute top-0 left-0 right-[380px] bottom-0 flex">
          <section className="absolute top-0 left-0 right-0 bottom-32 px-4 overflow-y-auto">
            <EventLog events={events} />
          </section>
          <section className="absolute h-32 left-0 right-0 bottom-0 p-4">
            <SessionControls
              startSession={startSession}
              stopSession={stopSession}
              sendClientEvent={sendClientEvent}
              sendTextMessage={sendTextMessage}
              events={events}
              isSessionActive={isSessionActive}
            />
          </section>
        </section>
        <section className="absolute top-0 w-[380px] right-0 bottom-0 p-4 pt-0 overflow-y-auto">
        </section>
      </main>
    </>
  );
}
