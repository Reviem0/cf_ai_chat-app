
    // ── Chat Manager ─────────────────────────────────────────────
    const CHAT_LIST_KEY = 'cf-chat-list';
    const ACTIVE_CHAT_KEY = 'cf-active-chat';

    function generateId() {
      return 'session-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    function loadChatList() {
      try { return JSON.parse(localStorage.getItem(CHAT_LIST_KEY) || '[]'); }
      catch { return []; }
    }

    function saveChatList(list) {
      localStorage.setItem(CHAT_LIST_KEY, JSON.stringify(list));
    }

    function getActiveId() {
      return localStorage.getItem(ACTIVE_CHAT_KEY);
    }

    function setActiveId(id) {
      localStorage.setItem(ACTIVE_CHAT_KEY, id);
    }

    // Ensure at least one chat exists
    let chatList = loadChatList();
    if (chatList.length === 0) {
      const first = { id: generateId(), title: 'New chat', createdAt: Date.now() };
      chatList.push(first);
      saveChatList(chatList);
      setActiveId(first.id);
    }
    let sessionId = getActiveId() || chatList[0].id;
    if (!chatList.find(c => c.id === sessionId)) {
      sessionId = chatList[0].id;
      setActiveId(sessionId);
    }

    let messageCount = 0;
    let firstUserMessage = null;

    const container = document.getElementById('chat-container');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const fileUpload = document.getElementById('file-upload');
    const memoryBar = document.getElementById('memory-bar');
    const chatListEl = document.getElementById('chat-list');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');

    // ── Sidebar toggle (mobile) ─────────────────────────────────
    function toggleSidebar() {
      sidebar.classList.toggle('open');
      sidebarOverlay.classList.toggle('open');
    }
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
    sidebarOverlay.addEventListener('click', toggleSidebar);

    // ── Render sidebar chat list ──────��─────────────────────────
    function renderChatList() {
      chatList = loadChatList();
      chatListEl.innerHTML = '';
      chatList.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'chat-item' + (chat.id === sessionId ? ' active' : '');
        item.innerHTML = `
          <span class="chat-item-icon">💬</span>
          <span class="chat-item-title">${escapeHtml(chat.title)}</span>
          <span class="chat-item-actions">
            <button class="chat-action-btn rename" title="Rename">✏️</button>
            <button class="chat-action-btn delete" title="Delete">🗑️</button>
          </span>`;

        // Click to switch
        item.addEventListener('click', (e) => {
          if (e.target.closest('.chat-action-btn')) return;
          switchToChat(chat.id);
        });

        // Rename
        item.querySelector('.rename').addEventListener('click', (e) => {
          e.stopPropagation();
          const newTitle = prompt('Rename chat:', chat.title);
          if (newTitle && newTitle.trim()) {
            chat.title = newTitle.trim();
            saveChatList(chatList);
            renderChatList();
          }
        });

        // Delete
        item.querySelector('.delete').addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm('Delete this chat?')) return;
          deleteChat(chat.id);
        });

        chatListEl.appendChild(item);
      });
    }

    function escapeHtml(str) {
      const d = document.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    }

    // ── Switch chat ─────────────────────────────────────────────
    function switchToChat(id) {
      sessionId = id;
      setActiveId(id);
      messageCount = 0;
      firstUserMessage = null;
      container.innerHTML = `<div class="empty-state" id="empty-state">
        <div class="big-icon">🤖</div>
        <h2>Start a conversation</h2>
        <p>Powered by Llama 3.3 on Cloudflare Workers AI with persistent memory via Durable Objects.</p>
        <div class="suggestion-chips">
          <button class="chip" data-prompt="Explain how Cloudflare Workers work">How do Workers work?</button>
          <button class="chip" data-prompt="Write a JavaScript function that reverses a string">Reverse a string</button>
          <button class="chip" data-prompt="What are Durable Objects and why are they useful?">What are Durable Objects?</button>
          <button class="chip" data-prompt="Tell me a fun fact about AI">Fun AI fact</button>
        </div>
      </div>`;
      bindChips();
      updateMemoryBar();
      renderChatList();
      if (sidebar.classList.contains('open')) toggleSidebar();
    }

    // ── New chat ────────────────────────────────────────────────
    function createNewChat() {
      const chat = { id: generateId(), title: 'New chat', createdAt: Date.now() };
      chatList.unshift(chat);
      saveChatList(chatList);
      switchToChat(chat.id);
    }
    document.getElementById('new-chat-btn').addEventListener('click', createNewChat);

    // ── Delete chat ─────────────────────────────────────────────
    async function deleteChat(id) {
      // Clear DO storage
      await fetch('/api/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
      });
      chatList = chatList.filter(c => c.id !== id);
      if (chatList.length === 0) {
        const fresh = { id: generateId(), title: 'New chat', createdAt: Date.now() };
        chatList.push(fresh);
      }
      saveChatList(chatList);
      if (id === sessionId) {
        switchToChat(chatList[0].id);
      } else {
        renderChatList();
      }
    }

    // ── Auto-title ──────────────────────────────────────────────
    function autoTitle(userMsg) {
      const chat = chatList.find(c => c.id === sessionId);
      if (chat && chat.title === 'New chat') {
        chat.title = userMsg.length > 40 ? userMsg.slice(0, 40) + '…' : userMsg;
        saveChatList(chatList);
        renderChatList();
      }
    }

    function updateMemoryBar() {
      memoryBar.innerHTML = `Session: <span>${sessionId.slice(0, 18)}…</span>  ·  Messages: <span>${messageCount}</span>  ·  Memory: <span>Durable Object + Vector DB</span>`;
    }
    updateMemoryBar();

    // ── Markdown-like rendering ────────────────────────────────
    function renderMarkdown(text) {
      return text
        .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .split('\n\n')
        .map(p => p.trim() ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '')
        .join('');
    }

    function addMessage(role, content) {
      const es = document.getElementById('empty-state');
      if (es) es.remove();
      messageCount++;
      updateMemoryBar();

      const div = document.createElement('div');
      div.className = 'message ' + role;

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = role === 'user' ? '🧑' : '🤖';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';

      const formatted = renderMarkdown(content);
      bubble.innerHTML = formatted || `<p>${content}</p>`;

      div.appendChild(avatar);
      div.appendChild(bubble);
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      return div;
    }

    function addTyping() {
      const div = document.createElement('div');
      div.className = 'message assistant';
      div.id = 'typing';
      div.innerHTML = `
        <div class="avatar">🤖</div>
        <div class="bubble"><div class="typing-indicator">
          <div class="dot"></div><div class="dot"></div><div class="dot"></div>
        </div></div>`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    // ── Send message ──────────────────────────────────────────
    async function sendMessage(message) {
      if (!message.trim()) return;
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;

      // Auto-title on first user message
      if (messageCount === 0) autoTitle(message);

      addMessage('user', message);
      addTyping();

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, sessionId }),
        });

        document.getElementById('typing')?.remove();

        if (!res.ok) throw new Error('Request failed');
        const data = await res.json();
        addMessage('assistant', data.response);
      } catch (err) {
        document.getElementById('typing')?.remove();
        addMessage('assistant', '⚠️ Something went wrong. Please try again.');
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    // ── Event listeners ────────────────────────────────────────

    // ── File Uploads ──────────────────────────────────────────
    fileUpload.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      // Reset input
      e.target.value = '';
      
      const filename = file.name;
      addMessage('user', `📎 Uploading document: **${filename}**...`);
      addTyping();
      
      try {
        let extractedText = '';
        const ext = filename.split('.').pop().toLowerCase();
        
        if (ext === 'txt') {
          extractedText = await file.text();
        } else if (ext === 'docx') {
          const arrayBuffer = await file.arrayBuffer();
          const result = await mammoth.extractRawText({ arrayBuffer });
          extractedText = result.value;
        } else if (ext === 'zip') {
          const zip = await JSZip.loadAsync(file);
          const textPromises = [];
          
          zip.forEach((relativePath, zipEntry) => {
            if (zipEntry.dir) return; // Ignore directories
            
            const entryExt = zipEntry.name.split('.').pop().toLowerCase();
            if (entryExt === 'txt') {
              textPromises.push(zipEntry.async('string'));
            } else if (entryExt === 'docx') {
              textPromises.push(zipEntry.async('arraybuffer').then(buffer => 
                mammoth.extractRawText({ arrayBuffer: buffer }).then(res => res.value)
              ));
            }
          });
          
          const texts = await Promise.all(textPromises);
          extractedText = texts.join('\n\n');
        } else {
          throw new Error('Unsupported file type');
        }
        
        extractedText = extractedText.trim();
        if (!extractedText) {
          throw new Error('No text could be extracted from the file.');
        }

        // Send to backend
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: extractedText,
            filename: filename,
            sessionId: sessionId
          })
        });

        document.getElementById('typing')?.remove();

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to process document');
        }

        addMessage('assistant', `✅ Successfully read **${filename}** and added it to my memory! You can now ask me questions about it.`);

      } catch (err) {
        console.error(err);
        document.getElementById('typing')?.remove();
        addMessage('assistant', `❌ ** Error uploading ${filename}:** ${err.message} `);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input.value.trim());
      }
    });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendMessage(input.value.trim());
    });

    // ── Suggestion chips ───────────────────────────────────────
    function bindChips() {
      document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const prompt = chip.getAttribute('data-prompt');
          if (prompt) sendMessage(prompt);
        });
      });
    }
    bindChips();

    // ── Clear history ──────────────────────────────────────────
    document.getElementById('clear-btn').addEventListener('click', async () => {
      await fetch('/api/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      container.innerHTML = `<div class="empty-state" id="empty-state">
        <div class="big-icon">✨</div>
        <h2>Conversation cleared</h2>
        <p>Memory has been reset. Start a new conversation.</p>
      </div>`;
      messageCount = 0;
      // Reset title
      const chat = chatList.find(c => c.id === sessionId);
      if (chat) { chat.title = 'New chat'; saveChatList(chatList); renderChatList(); }
      updateMemoryBar();
    });

    // ── Facts modal ────────────────────────────────────────────
    const factsModal = document.getElementById('facts-modal');
    const factInput = document.getElementById('fact-input');
    const factStatus = document.getElementById('fact-status');
    const factsList = document.getElementById('facts-list');

    async function loadFacts() {
      factsList.innerHTML = '<div class="facts-loading">Loading facts…</div>';
      try {
        const res = await fetch('/api/facts');
        const data = await res.json();
        renderFacts(data.facts || []);
      } catch (err) {
        factsList.innerHTML = '<div class="facts-empty">Failed to load facts.</div>';
      }
    }

    function renderFacts(facts) {
      if (facts.length === 0) {
        factsList.innerHTML = '<div class="facts-empty">No facts stored yet. Add one above!</div>';
        return;
      }
      factsList.innerHTML = '<div class="facts-list-label">Stored Facts (' + facts.length + ')</div>';
      facts.forEach(function(f) {
        const item = document.createElement('div');
        item.className = 'fact-item';
        item.innerHTML =
          '<div class="fact-item-content">' + escapeHtml(f.content) + '</div>' +
          '<div class="fact-item-actions">' +
            '<button class="fact-action edit" title="Edit">✏️</button>' +
            '<button class="fact-action delete" title="Delete">🗑️</button>' +
          '</div>';

        // Delete single fact
        item.querySelector('.delete').addEventListener('click', async function() {
          if (!confirm('Delete this fact?')) return;
          try {
            await fetch('/api/facts?id=' + encodeURIComponent(f.id), { method: 'DELETE' });
            item.remove();
            loadFacts();
          } catch (err) {
            alert('Failed to delete fact.');
          }
        });

        // Edit fact: delete old, add updated
        item.querySelector('.edit').addEventListener('click', async function() {
          const newContent = prompt('Edit fact:', f.content);
          if (newContent === null || !newContent.trim()) return;
          try {
            await fetch('/api/facts?id=' + encodeURIComponent(f.id), { method: 'DELETE' });
            await fetch('/api/facts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fact: newContent.trim() }),
            });
            loadFacts();
          } catch (err) {
            alert('Failed to update fact.');
          }
        });

        factsList.appendChild(item);
      });
    }

    document.getElementById('facts-btn').addEventListener('click', () => {
      factsModal.classList.add('open');
      loadFacts();
    });

    document.getElementById('facts-modal-close').addEventListener('click', () => {
      factsModal.classList.remove('open');
    });

    factsModal.addEventListener('click', (e) => {
      if (e.target === factsModal) factsModal.classList.remove('open');
    });

    document.getElementById('add-fact-btn').addEventListener('click', async () => {
      const fact = factInput.value.trim();
      if (!fact) return;

      const btn = document.getElementById('add-fact-btn');
      btn.disabled = true;
      factStatus.textContent = '';

      try {
        const res = await fetch('/api/facts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fact }),
        });

        if (!res.ok) throw new Error('Failed');
        factInput.value = '';
        factStatus.className = 'fact-status success';
        factStatus.textContent = '✓ Fact stored!';
        loadFacts();
      } catch (err) {
        factStatus.className = 'fact-status error';
        factStatus.textContent = '✕ Failed to store fact. Please try again.';
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('clear-facts-btn').addEventListener('click', async () => {
      if (!confirm('Delete all stored facts? This cannot be undone.')) return;

      try {
        await fetch('/api/facts', { method: 'DELETE' });
        factStatus.className = 'fact-status success';
        factStatus.textContent = '✓ All facts cleared.';
        loadFacts();
      } catch (err) {
        factStatus.className = 'fact-status error';
        factStatus.textContent = '✕ Failed to clear facts.';
      }
    });

    // ── Settings modal ─────────────────────────────────────────
    const settingsModal = document.getElementById('settings-modal');
    const settingsBtn = document.getElementById('settings-btn');
    const contextTemplateInput = document.getElementById('context-template-input');
    const instructModeInput = document.getElementById('instruct-mode-input');
    const settingsSaveBtn = document.getElementById('settings-save-btn');
    const settingsResetBtn = document.getElementById('settings-reset-btn');
    const settingsStatus = document.getElementById('settings-status');

    async function loadSettings() {
      contextTemplateInput.value = '';
      instructModeInput.value = '';
      settingsStatus.textContent = '';
      settingsStatus.className = 'settings-status';

      try {
        const res = await fetch(`/api/settings?sessionId=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error('Failed to load settings');
        const data = await res.json();
        contextTemplateInput.value = data.contextTemplate || '';
        instructModeInput.value = data.instructMode || '';
      } catch (err) {
        settingsStatus.className = 'settings-status error';
        settingsStatus.textContent = '✕ Failed to load settings.';
      }
    }

    settingsBtn.addEventListener('click', () => {
      settingsModal.classList.add('open');
      loadSettings();
    });

    document.getElementById('settings-modal-close').addEventListener('click', () => {
      settingsModal.classList.remove('open');
    });

    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) settingsModal.classList.remove('open');
    });

    settingsSaveBtn.addEventListener('click', async () => {
      settingsSaveBtn.disabled = true;
      settingsStatus.className = 'settings-status';
      settingsStatus.textContent = 'Saving...';

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            contextTemplate: contextTemplateInput.value,
            instructMode: instructModeInput.value
          }),
        });
        if (!res.ok) throw new Error('Failed to save');
        settingsStatus.className = 'settings-status success';
        settingsStatus.textContent = '✓ Settings saved for this chat!';
        setTimeout(() => {
          if (settingsModal.classList.contains('open')) {
            settingsModal.classList.remove('open');
          }
        }, 1200);
      } catch (err) {
        settingsStatus.className = 'settings-status error';
        settingsStatus.textContent = '✕ Failed to save settings.';
      } finally {
        settingsSaveBtn.disabled = false;
      }
    });

    settingsResetBtn.addEventListener('click', async () => {
      if (!confirm('Clear your custom settings for this chat and return to default behavior?')) return;
      contextTemplateInput.value = '';
      instructModeInput.value = '';
      // Save the empty values
      settingsSaveBtn.click();
    });

    // ── Init ───────────────────────────────────────────────────
    renderChatList();
