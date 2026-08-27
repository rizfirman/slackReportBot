import http from 'http';

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log('📥 Request received');
      
      let event;
      try { event = JSON.parse(body); } catch(e) { event = {}; }
      
      const commandId = event.chat?.appCommandPayload?.appCommandMetadata?.appCommandId 
                      || event.message?.slashCommand?.commandId;

      if (commandId == 1) {
        // Format actionResponse
        const response = JSON.stringify({
          actionResponse: {
            type: "DIALOG",
            dialogAction: {
              dialog: {
                body: {
                  sections: [{
                    widgets: [{
                      textParagraph: {
                        text: "🎉 Dialog dari raw HTTP server!"
                      }
                    }]
                  }]
                }
              }
            }
          }
        });

        console.log('📤 Sending response (actionResponse):', response.length, 'bytes');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(response)
        });
        res.end(response);
        return;
      }

      // Fallback
      const fallback = JSON.stringify({});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(fallback) });
      res.end(fallback);
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  }
});

server.listen(3000, () => {
  console.log('⚡ Raw HTTP test server on port 3000');
});
