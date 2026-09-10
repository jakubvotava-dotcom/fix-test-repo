module.exports = function (RED) {
  function LlmCallNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    this.llmConfig = RED.nodes.getNode(config.llmConfig);
    this.systemPrompt = config.systemPrompt || '';
    // Fix vada 1: zero is a valid temperature - the original
    // "parseFloat(x) || 0.3" turned 0 into 0.3 (0 is falsy in JS)
    const parsedTemperature = parseFloat(config.temperature);
    this.temperature = Number.isFinite(parsedTemperature) ? parsedTemperature : 0.3;
    this.jsonMode = config.jsonMode || false;
    this.maxTokens = parseInt(config.maxTokens, 10) || 4096;

    node.on('input', function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (err) { if (err) node.error(err, msg); };

      if (!node.llmConfig) {
        done(new Error('No LLM provider configured'));
        return;
      }

      var apiKey = (node.llmConfig.credentials && node.llmConfig.credentials.apiKey) || '';

      var userContent = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload || '');
      if (!userContent) {
        done(new Error('No input — send text in msg.payload'));
        return;
      }

      node.status({ fill: 'blue', shape: 'dot', text: 'calling LLM...' });

      var messages = [];
      if (node.systemPrompt) {
        messages.push({ role: 'system', content: node.systemPrompt });
      }
      // Support msg.messages for multi-turn conversations
      // Fix vada 3: msg.systemPrompt overrides the node config
      // (needed for prompts synced from Confluence)
      var systemPrompt = (typeof msg.systemPrompt === 'string' && msg.systemPrompt.length > 0)
        ? msg.systemPrompt
        : node.systemPrompt;
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: userContent });

      var body = {
        model: node.llmConfig.model,
        messages: messages,
        temperature: node.temperature,
        max_tokens: node.maxTokens,
      };

    // Pass tools if provided in msg.tools (for advanced use)
      if (msg.tools && Array.isArray(msg.tools) && msg.tools.length > 0) {
        body.tools = msg.tools;
      }

      if (node.jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      var url = node.llmConfig.baseUrl.replace(/\/+$/, '') + '/chat/completions';

      // Fix vada 2: empty API key = no Authorization header (Ollama etc.)
      var headers = { 'Content-Type': 'application/json' };
      if (apiKey) { headers['Authorization'] = 'Bearer ' + apiKey; }

      fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (t) {
            throw new Error('LLM API error ' + resp.status + ': ' + t.slice(0, 500));
          });
        }
        return resp.json();
      }).then(function (data) {
        var choice = data.choices && data.choices[0];
        if (!choice) throw new Error('No response from LLM');

        msg.payload = choice.message.content || '';
        msg.llmResponse = choice.message;
        msg.usage = data.usage;

        if (choice.message.tool_calls) {
          msg.toolCalls = choice.message.tool_calls;
        }

        node.status({ fill: 'green', shape: 'dot', text: 'done' });
        send(msg);
        done();
      }).catch(function (err) {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
        done(err);
      });
    });
  }

  RED.nodes.registerType('llm-call', LlmCallNode);
};
