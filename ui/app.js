// ── State ────────────────────────────────────────────────────────────────────
let ws = null;
let reconnectTimer = null;
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('chat-input');
const formEl = document.getElementById('chat-form');
const agentListEl = document.getElementById('agent-list');
const statusEl = document.getElementById('connection-status');
const thinkingEl = document.getElementById('thinking');
let reconnectAttempts = 0;
let lastAgentName = null; // for message grouping
let sessionToken = null;

// ── Mission state ───────────────────────────────────────────────────────────
let activeChannelId = 'local:general';
let missions = [];

// ── Auth: fetch session token and set up authenticated fetch ────────────────

async function initAuth() {
  try {
    const resp = await fetch('/api/auth/token');
    const data = await resp.json();
    sessionToken = data.token;
  } catch { /* token fetch failed — auth may not be enabled */ }
}

/** Authenticated fetch wrapper */
function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}), 'Content-Type': 'application/json' };
  if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
  return fetch(url, { ...opts, headers });
}

// Empty state management (defined early so append functions can call it)
function hideEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.classList.add('hidden');
}

// ── Mobile hamburger ────────────────────────────────────────────────────────

const hamburgerBtn = document.getElementById('hamburger');
const sidebarEl = document.getElementById('sidebar');

hamburgerBtn.addEventListener('click', () => {
  sidebarEl.classList.toggle('open');
});

// Close sidebar on outside click (mobile)
document.addEventListener('click', (e) => {
  if (sidebarEl.classList.contains('open') && !sidebarEl.contains(e.target) && e.target !== hamburgerBtn) {
    sidebarEl.classList.remove('open');
  }
});

// ── Agent sidebar search ─────────────────────────────────────────────────────

const agentSearchEl = document.getElementById('agent-search');
if (agentSearchEl) {
  agentSearchEl.addEventListener('input', () => {
    const q = agentSearchEl.value.toLowerCase();
    agentListEl.querySelectorAll('li').forEach(li => {
      const title = li.querySelector('.agent-title');
      li.style.display = (!q || title?.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
  });
}

let hasProjects = false;

let isExecutorNoop = true;

function updateSettingsCue() {
  const btn = document.getElementById('settings-btn');
  const select = document.getElementById('executor-select');
  if (hasProjects && isExecutorNoop) {
    btn.classList.add('needs-attention');
    select.classList.add('highlight-attention');
  } else {
    btn.classList.remove('needs-attention');
    select.classList.remove('highlight-attention');
  }
}

// ── Notification sound ──────────────────────────────────────────────────────

let notifMuted = localStorage.getItem('notifMuted') === 'true';
let notifCtx = null;

function playNotifSound() {
  if (notifMuted) return;
  try {
    if (!notifCtx) notifCtx = new AudioContext();
    const osc = notifCtx.createOscillator();
    const gain = notifCtx.createGain();
    osc.connect(gain);
    gain.connect(notifCtx.destination);
    osc.frequency.value = 660;
    gain.gain.value = 0.08;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, notifCtx.currentTime + 0.15);
    osc.stop(notifCtx.currentTime + 0.15);
  } catch { /* audio not available */ }
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tokenParam = sessionToken ? `?token=${sessionToken}` : '';
  ws = new WebSocket(`${proto}://${location.host}/ws${tokenParam}`);

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onclose = () => {
    statusEl.textContent = 'Reconnecting...';
    statusEl.className = 'status disconnected';
    const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const { event: type, data } = JSON.parse(event.data);

    switch (type) {
      case 'message': {
        // Filter messages by active channel
        const msgChannel = data.channel_id || 'local:general';
        if (msgChannel !== activeChannelId) break;
        if (thinkingEl) thinkingEl.classList.add('hidden');
        appendAgentMessage(data);
        // Only play sound for real agent responses, not system/execution messages
        if (data.content && !data.content.startsWith('**[System]**')) playNotifSound();
        break;
      }
      case 'user_message': {
        const userMsgChannel = data.channel_id || 'local:general';
        if (userMsgChannel !== activeChannelId) break;
        appendUserMessage(data);
        break;
      }
      case 'reaction':
        // Could show reactions — skip for now
        break;
      case 'proposal_resolved':
        handleProposalResolved(data);
        break;
      case 'project_added':
      case 'project_removed':
        loadProjects();
        break;
      case 'mission_created':
      case 'mission_updated':
        loadMissions();
        break;
      case 'settings_changed':
        if (data.autonomousMode !== undefined) autonomousToggle.checked = data.autonomousMode;
        if (data.executionBackend) {
          executorSelect.value = data.executionBackend;
          isExecutorNoop = (data.executionBackend === 'noop');
          updateSettingsCue();
          permashipHint.classList.toggle('hidden', data.executionBackend !== 'permaship');
        }
        if (data.llmProvider) { configLlmEl.textContent = data.llmProvider; }
        if (data.needsSetup === false) setupOverlay.classList.add('hidden');
        break;
      case 'knowledge_changed':
        loadKnowledge();
        break;
      case 'error':
        appendSystemMessage(data.message || 'An error occurred');
        break;
    }
  };
}


// ── Message Rendering ────────────────────────────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Copy message text to clipboard */
function copyMessage(btn) {
  const msg = btn.closest('.message');
  const body = msg?.querySelector('.body');
  if (!body) return;
  navigator.clipboard.writeText(body.textContent || '').then(() => {
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });
}

/** Minimal markdown: bold, code, code blocks, links */
function renderMarkdown(text) {
  let html = escapeHtml(text);
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return html;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function extractAgentName(content) {
  // Agent messages are prefixed with **[Agent Title]**
  const match = content?.match(/^\*\*\[(.+?)\]\*\*\s*/);
  if (match) return { name: match[1], body: content.slice(match[0].length) };
  return { name: null, body: content };
}

function appendUserMessage(data) {
  lastAgentName = null; // reset grouping
  hideEmptyState();
  const el = document.createElement('div');
  el.className = 'message user';
  el.innerHTML = `
    <div class="meta">
      <span class="author">${escapeHtml(data.authorName || 'You')}</span>
      <span class="time">${formatTime(data.timestamp)}</span>
    </div>
    <div class="body">${renderMarkdown(data.content)}</div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendAgentMessage(data) {
  hideEmptyState();
  const { name, body } = extractAgentName(data.content || '');
  const agentName = name || 'Agent';
  const el = document.createElement('div');
  // Group consecutive messages from same agent
  const isGrouped = lastAgentName === agentName;
  el.className = 'message agent';
  lastAgentName = agentName;

  let html = '';
  if (!isGrouped) {
    html += `<div class="meta">
      <span class="author">${escapeHtml(agentName)}</span>
      <span class="time">${formatTime(data.timestamp)}</span>
    </div>`;
  }
  html += `<div class="body">${renderMarkdown(body)}</div>`;
  html += `<button class="copy-btn" onclick="copyMessage(this)">Copy</button>`;

  // Render embed if present
  if (data.embed_title || data.embed_description) {
    html += `<div class="embed">`;
    if (data.embed_title) html += `<h4>${escapeHtml(data.embed_title)}</h4>`;
    if (data.embed_description) html += `<p>${renderMarkdown(data.embed_description)}</p>`;
    html += `</div>`;
  }

  // Render diff if present
  if (data.diff) {
    html += `
      <details class="diff-details">
        <summary>View Changes (git diff)</summary>
        <div class="body">${renderMarkdown('```diff\n' + data.diff + '\n```')}</div>
      </details>
    `;
  }

  // Render retry button for failed executions
  if (data.retry_ticket_id) {
    html += `<div class="proposal-buttons"><button class="btn-approve" onclick="handleRetryExecution('${escapeHtml(data.retry_ticket_id)}', this)">Retry Execution</button></div>`;
  }

  // Render approve/reject buttons if components present
  if (data.components && data.components.length > 0) {
    let actionId = '';
    // Extract action ID from signed custom_id (format: approve_tool:<actionId>:<sig>)
    for (const comp of data.components) {
      if (comp.type === 'button' && comp.custom_id?.includes(':')) {
        actionId = comp.custom_id.split(':')[1];
        break;
      }
    }

    html += `<div class="proposal-buttons" data-msg-id="${escapeHtml(data.id)}" data-action-id="${escapeHtml(actionId)}">`;
    for (const comp of data.components) {
      if (comp.type === 'button') {
        const cls = comp.style === 'success' ? 'btn-approve' : comp.style === 'danger' ? 'btn-reject' : '';
        const action = comp.custom_id?.startsWith('approve') ? 'approve' : 'reject';
        
        let subLabelHtml = '';
        let ariaLabel = '';
        if (action === 'approve') {
          const backend = executorSelect ? executorSelect.value : 'noop';
          const consequenceText = backend === 'noop' ? 'Creates ticket' : 'Creates ticket & starts execution';
          subLabelHtml = `<span class="btn-sublabel" aria-hidden="true">${consequenceText}</span>`;
          ariaLabel = ` aria-label="${escapeHtml(comp.label)}. Consequence: ${consequenceText}"`;
        }
        
        html += `<button class="${cls}"${ariaLabel} onclick="handleProposal('${action}', '${escapeHtml(actionId)}', this)">
          <span class="btn-main-label">${escapeHtml(comp.label)}</span>
          ${subLabelHtml}
        </button>`;
      }
    }
    html += `</div>`;
  }


  el.innerHTML = html;
  messagesEl.appendChild(el);
  scrollToBottom();
}



function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'message system';
  el.innerHTML = `
    <div class="meta"><span class="author">System</span></div>
    <div class="body">${escapeHtml(text)}</div>
  `;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendHistoryMessage(msg) {
  const el = document.createElement('div');
  el.className = `message ${msg.isAgent ? 'agent' : 'user'}`;

  if (msg.isAgent) {
    const { name, body } = extractAgentName(msg.content || '');
    const agentName = name || msg.agentId || 'Agent';
    const isGrouped = lastAgentName === agentName;
    lastAgentName = agentName;
    let html = '';
    if (!isGrouped) {
      html += `<div class="meta">
        <span class="author">${escapeHtml(agentName)}</span>
        <span class="time">${formatTime(msg.createdAt)}</span>
      </div>`;
    }
    html += `<div class="body">${renderMarkdown(body)}</div>`;
    html += `<button class="copy-btn" onclick="copyMessage(this)">Copy</button>`;
    el.innerHTML = html;
  } else {
    lastAgentName = null;
    el.innerHTML = `
      <div class="meta">
        <span class="author">${escapeHtml(msg.authorName)}</span>
        <span class="time">${formatTime(msg.createdAt)}</span>
      </div>
      <div class="body">${renderMarkdown(msg.content)}</div>
    `;
  }
  messagesEl.appendChild(el);
}

function scrollToBottom() {
  if (typeof trimOldMessages === 'function') trimOldMessages();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Proposal Actions ─────────────────────────────────────────────────────────

let undoToastTimeout = null;

function showUndoToast(actionId, container, onComplete) {
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  
  toastContainer.innerHTML = '';
  toastContainer.classList.remove('hidden');
  
  const toast = document.createElement('div');
  toast.className = 'undo-toast';
  toast.innerHTML = `
    <span>Proposal dismissed.</span>
    <button id="undo-btn">Undo</button>
  `;
  
  toastContainer.appendChild(toast);
  
  let cancelled = false;
  
  document.getElementById('undo-btn').addEventListener('click', () => {
    cancelled = true;
    toastContainer.classList.add('hidden');
    if (container) {
      container.style.display = ''; // Restore buttons
      container.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  });
  
  clearTimeout(undoToastTimeout);
  undoToastTimeout = setTimeout(() => {
    if (!cancelled) {
      toastContainer.classList.add('hidden');
      onComplete();
    }
  }, 5000);
}

async function handleProposal(action, actionId, btn) {
  if (!actionId) return;
  
  const container = btn?.closest('.proposal-buttons');
  
  if (action === 'reject') {
    if (container) {
      container.style.display = 'none'; // Optimistically hide
    }
    
    showUndoToast(actionId, container, async () => {
      try {
        const resp = await apiFetch(`/api/proposals/${actionId}/reject`, { method: 'POST', body: '{}' });
        const data = await resp.json();
        if (resp.ok && data.success) {
          appendSystemMessage(`Proposal rejected.`);
        } else {
          appendSystemMessage(`Failed to reject proposal: ${data.error || 'Unknown error'}`);
          if (container) {
            container.style.display = '';
            container.querySelectorAll('button').forEach(b => b.disabled = false);
          }
        }
      } catch (err) {
        appendSystemMessage(`Failed to reject proposal.`);
        if (container) {
          container.style.display = '';
          container.querySelectorAll('button').forEach(b => b.disabled = false);
        }
      }
    });
    return;
  }

  // Disable all buttons in this block immediately
  if (container) {
    container.querySelectorAll('button').forEach(b => b.disabled = true);
    if (btn) {
      btn.dataset.originalHtml = btn.innerHTML;
      const mainLabel = btn.querySelector('.btn-main-label');
      if (mainLabel) mainLabel.textContent = 'Processing...';
      else btn.textContent = 'Processing...';
    }
  }

  try {
    const resp = await apiFetch(`/api/proposals/${actionId}/${action}`, { method: 'POST', body: '{}' });
    const data = await resp.json();
    if (resp.ok && data.success) {
      appendSystemMessage(`Proposal ${action}d.`);
      // Container will be hidden via WebSocket event 'proposal_resolved'
    } else {
      appendSystemMessage(`Failed to ${action} proposal: ${data.error || 'Unknown error'}`);
      if (container) {
        container.querySelectorAll('button').forEach(b => { b.disabled = false; if (b.dataset.originalHtml) b.innerHTML = b.dataset.originalHtml; });
      }
    }
  } catch (err) {
    appendSystemMessage(`Failed to ${action} proposal.`);
    if (container) {
      container.querySelectorAll('button').forEach(b => { b.disabled = false; if (b.dataset.originalHtml) b.innerHTML = b.dataset.originalHtml; });
    }
  }
}

function handleProposalResolved(data) {
  const { id, status } = data;
  // Find all button containers for this action and hide them
  document.querySelectorAll(`.proposal-buttons[data-action-id="${id}"]`).forEach(el => {
    el.style.display = 'none';
  });
}


async function handleRetryExecution(ticketId, btn) {
  if (!ticketId) return;
  btn.disabled = true;
  btn.textContent = 'Retrying...';
  try {
    const resp = await fetch(`/api/executions/${ticketId}/retry`, { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      btn.textContent = 'Retried';
      appendSystemMessage('Execution retry dispatched.');
    } else {
      btn.disabled = false;
      btn.textContent = 'Retry Execution';
      appendSystemMessage(`Retry failed: ${data.error}`);
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Retry Execution';
    appendSystemMessage('Failed to retry execution.');
  }
}

// ── Proposals Panel ──────────────────────────────────────────────────────────

const proposalsListEl = document.getElementById('proposals-list');
const proposalsEmptyEl = document.getElementById('proposals-empty');
let currentProposalFilter = 'pending';

// Proposals panel toggle
const proposalsPanel = document.getElementById('proposals-panel');
const proposalsBtn = document.getElementById('proposals-btn');
const proposalsClose = document.getElementById('proposals-close');
const proposalsCountEl = document.getElementById('proposals-count');

if (proposalsBtn) {
  proposalsBtn.addEventListener('click', () => {
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel && !settingsPanel.classList.contains('hidden')) settingsPanel.classList.add('hidden');
    proposalsPanel.classList.toggle('hidden');
    if (!proposalsPanel.classList.contains('hidden')) loadProposals();
  });
}
if (proposalsClose) {
  proposalsClose.addEventListener('click', () => proposalsPanel.classList.add('hidden'));
}

// Filter buttons
document.querySelectorAll('.proposal-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.proposal-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentProposalFilter = btn.dataset.status;
    loadProposals();
  });
});

async function loadProposals() {
  if (!proposalsListEl) return;
  try {
    const query = currentProposalFilter ? `?status=${currentProposalFilter}` : '';
    const resp = await apiFetch(`/api/proposals${query}`);
    const { proposals } = await resp.json();
    proposalsListEl.innerHTML = '';

    if (!proposals || proposals.length === 0) {
      proposalsEmptyEl.style.display = 'block';
      return;
    }
    proposalsEmptyEl.style.display = 'none';

    for (const p of proposals) {
      const args = typeof p.args === 'string' ? JSON.parse(p.args) : (p.args || {});
      const title = args.title || p.description || 'Untitled';
      const desc = args.description || p.description || '';
      const kind = args.kind || 'task';
      const agent = p.agentId || 'unknown';
      const status = p.status || 'unknown';
      const created = new Date(p.createdAt).toLocaleString();
      const reason = args.ctoDecisionReason || args.ctoRejectionReason || args.ctoDeferralReason || '';

      const card = document.createElement('div');
      card.className = 'proposal-card';

      let actionsHtml = '';
      if (status === 'pending') {
        actionsHtml = `
          <div class="proposal-card-actions">
            <button class="btn-approve" onclick="approveProposal('${p.id}', this)">Approve</button>
            <button class="btn-reject" onclick="rejectProposal('${p.id}', this)">Reject</button>
          </div>`;
      }

      let reasonHtml = '';
      if (reason) {
        reasonHtml = `<div class="proposal-card-desc" style="margin-top:4px;font-style:italic;opacity:0.8">Reason: ${escapeHtml(reason)}</div>`;
      }

      const statusLabel = status === 'nexus_review' ? 'in review' : status;

      card.innerHTML = `
        <div class="proposal-card-header">
          <span class="proposal-card-title">${escapeHtml(title)}</span>
          <span class="proposal-card-badge ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="proposal-card-meta">
          <span>${escapeHtml(kind)}</span> &middot;
          <span>${escapeHtml(agent)}</span> &middot;
          <span>${created}</span>
        </div>
        <div class="proposal-card-desc">${escapeHtml(desc.slice(0, 200))}${desc.length > 200 ? '...' : ''}</div>
        ${reasonHtml}
        ${actionsHtml}
      `;
      proposalsListEl.appendChild(card);
    }
  } catch {
    // Not critical
  }
}

async function approveProposal(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Approving...';
  try {
    const resp = await apiFetch(`/api/proposals/${id}/approve`, { method: 'POST', body: '{}' });
    const data = await resp.json();
    if (data.success) {
      loadProposals();
      appendSystemMessage('Proposal approved.');
    } else {
      btn.disabled = false;
      btn.textContent = 'Approve';
      appendSystemMessage(`Approval failed: ${data.error}`);
    }
  } catch {
    btn.disabled = false;
    btn.textContent = 'Approve';
  }
}

async function rejectProposal(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Rejecting...';
  try {
    const resp = await apiFetch(`/api/proposals/${id}/reject`, { method: 'POST', body: '{}' });
    const data = await resp.json();
    if (data.success) {
      loadProposals();
      appendSystemMessage('Proposal rejected.');
    } else {
      btn.disabled = false;
      btn.textContent = 'Reject';
      appendSystemMessage(`Rejection failed: ${data.error}`);
    }
  } catch {
    btn.disabled = false;
    btn.textContent = 'Reject';
  }
}

// Update pending count badge
const pendingBanner = document.getElementById('pending-banner');
const pendingBannerText = document.getElementById('pending-banner-text');

async function updateProposalsCount() {
  try {
    const resp = await apiFetch('/api/proposals?status=pending');
    const { proposals } = await resp.json();
    const count = proposals?.length ?? 0;
    if (proposalsCountEl) {
      proposalsCountEl.textContent = count;
      proposalsCountEl.classList.toggle('hidden', count === 0);
    }
    if (pendingBanner) {
      pendingBanner.classList.toggle('hidden', count === 0);
      if (pendingBannerText) pendingBannerText.textContent = `${count} proposal${count !== 1 ? 's' : ''} awaiting review`;
    }
  } catch { /* not critical */ }
}

// Poll pending count every 30s
updateProposalsCount();
setInterval(updateProposalsCount, 30_000);

// ── Project Management ───────────────────────────────────────────────────────

const projectListEl = document.getElementById('project-list');
const addProjectBtn = document.getElementById('add-project-btn');
const addProjectForm = document.getElementById('add-project-form');
const projectNameInput = document.getElementById('project-name');
const projectPathInput = document.getElementById('project-path');
const projectSubmitBtn = document.getElementById('project-submit');
const projectCancelBtn = document.getElementById('project-cancel');

addProjectBtn.addEventListener('click', () => {
  addProjectForm.classList.toggle('hidden');
  if (!addProjectForm.classList.contains('hidden')) projectNameInput.focus();
});

projectCancelBtn.addEventListener('click', () => {
  addProjectForm.classList.add('hidden');
  projectNameInput.value = '';
  projectPathInput.value = '';
});

// Clear validation error on input
projectNameInput.addEventListener('input', () => projectNameInput.classList.remove('input-error'));
projectPathInput.addEventListener('input', () => projectPathInput.classList.remove('input-error'));

// Close project form on outside click
document.addEventListener('click', (e) => {
  if (!addProjectForm.classList.contains('hidden') && !addProjectForm.contains(e.target) && e.target !== addProjectBtn) {
    addProjectForm.classList.add('hidden');
  }
});

// Update placeholder when source type changes
document.querySelectorAll('input[name="source"]').forEach(radio => {
  radio.addEventListener('change', () => {
    projectPathInput.placeholder = radio.value === 'local' ? '/path/to/repo' : 'https://github.com/user/repo';
  });
});

projectSubmitBtn.addEventListener('click', async () => {
  const name = projectNameInput.value.trim();
  const pathOrUrl = projectPathInput.value.trim();
  const sourceType = document.querySelector('input[name="source"]:checked').value;

  if (!name) { projectNameInput.focus(); projectNameInput.classList.add('input-error'); return; }
  if (!pathOrUrl) { projectPathInput.focus(); projectPathInput.classList.add('input-error'); return; }
  projectNameInput.classList.remove('input-error');
  projectPathInput.classList.remove('input-error');

  projectSubmitBtn.disabled = true;
  try {
    const body = sourceType === 'local'
      ? { name, localPath: pathOrUrl }
      : { name, remoteUrl: pathOrUrl };

    const resp = await apiFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();

    if (data.success) {
      addProjectForm.classList.add('hidden');
      projectNameInput.value = '';
      projectPathInput.value = '';
      loadProjects();
      if (data.cloning) {
        appendSystemMessage(`Cloning ${pathOrUrl}... This may take a moment.`);
      } else {
        appendSystemMessage(`Project "${name}" added.`);
      }
      // Guide user to set up an executor if still on noop
      if (executorSelect.value === 'noop') {
        appendSystemMessage(
          'Next step: choose an execution backend so approved tickets get worked on.\n\n' +
          'In the Settings panel (sidebar), set "Executor" to one of:\n' +
          '  - **Claude Code** — uses your local `claude` CLI\n' +
          '  - **Gemini CLI** — uses your local `gemini` CLI\n' +
          '  - **Codex CLI** — uses your local `codex` CLI\n' +
          '  - **PermaShip** — managed execution ([sign up](https://permaship.ai/pricing))\n\n' +
          'Without an executor, approved tickets are tracked but no code changes are made.'
        );
      }
    } else {
      appendSystemMessage(`Failed to add project: ${data.error}`);
    }
  } catch (err) {
    appendSystemMessage('Failed to add project.');
  } finally {
    projectSubmitBtn.disabled = false;
  }
});

async function loadProjects() {
  try {
    const resp = await apiFetch('/api/projects');
    const { projects } = await resp.json();
    projectListEl.innerHTML = '';
    const projHeading = projectListEl.previousElementSibling;
    if (projHeading && projHeading.tagName === 'H2') projHeading.textContent = `Projects (${projects.length})`;

    if (projects.length === 0) {
      hasProjects = false;
      updateSettingsCue();
      const li = document.createElement('li');
      li.style.color = 'var(--text-muted)';
      li.style.fontSize = '11px';
      li.textContent = 'No projects connected';
      projectListEl.appendChild(li);
      return;
    }

    hasProjects = true;
    updateSettingsCue();

    for (const p of projects) {
      const li = document.createElement('li');
      const badgeClass = p.cloneStatus === 'cloning' ? 'project-badge cloning' :
                         p.cloneStatus === 'error' ? 'project-badge error' : 'project-badge';
      const badge = p.sourceType === 'git' ? `<span class="${badgeClass}">${p.cloneStatus === 'ready' ? 'git' : p.cloneStatus}</span>` : '<span class="project-badge">local</span>';
      const autoIcon = p.autonomousMode === true ? 'A' : p.autonomousMode === false ? 'M' : '';
      const autoTitle = p.autonomousMode === true ? 'Autonomous (click to change to Manual)'
        : p.autonomousMode === false ? 'Manual (click to clear override)' : 'Inherit global (click to set Autonomous)';
      const autoBadge = `<span class="project-badge" style="cursor:pointer;${p.autonomousMode === true ? 'background:#2d6a4f;' : p.autonomousMode === false ? 'background:#6c3a2a;' : ''}" onclick="cycleProjectAutonomous('${p.id}',${JSON.stringify(p.autonomousMode)})" title="${autoTitle}">${autoIcon || '\u2022'}</span>`;
      li.innerHTML = `<span><span class="project-name">${escapeHtml(p.name)}</span>${badge}${autoBadge}</span><button class="remove-btn" onclick="removeProject('${p.id}')" title="Remove">&times;</button>`;
      projectListEl.appendChild(li);
    }
  } catch (err) {
    // Projects not loaded — not critical
  }
}

async function setMissionAutonomous(missionId, value) {
  const enabled = value === 'null' ? null : value === 'true';
  await apiFetch(`/api/missions/${missionId}/autonomous`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

async function cycleProjectAutonomous(projectId, current) {
  const next = current === null ? true : current === true ? false : null;
  await apiFetch(`/api/projects/${projectId}/autonomous`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: next }),
  });
  loadProjects();
}

async function removeProject(id) {
  if (!confirm('Remove this project? Agents will lose access to its code and docs.')) return;
  try {
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    loadProjects();
  } catch (err) {
    appendSystemMessage('Failed to remove project.');
  }
}

// ── Config & Settings ────────────────────────────────────────────────────────

const configLlmEl = document.getElementById('config-llm');
const executorSelect = document.getElementById('executor-select');
const permashipHint = document.getElementById('permaship-hint');
const autonomousToggle = document.getElementById('autonomous-toggle');
const worktreeToggle = document.getElementById('worktree-toggle');

async function loadConfig() {
  try {
    const resp = await apiFetch('/api/config');
    const cfg = await resp.json();
    configLlmEl.textContent = cfg.llmProvider || '-';
    const backend = cfg.executionBackend || 'noop';
    executorSelect.value = backend;
    isExecutorNoop = (backend === 'noop');
    updateSettingsCue();
    permashipHint.classList.toggle('hidden', backend !== 'permaship');
    autonomousToggle.checked = cfg.autonomousMode || false;
    if (worktreeToggle) worktreeToggle.checked = cfg.useWorktrees || false;
    showSetupIfNeeded(cfg);
    // Test executor on load if one is configured (skip noop)
    if (backend !== 'noop') testExecutor(backend);
  } catch (err) {
    // Config not loaded — not critical
  }
}

// Executor dropdown change
const executorStatusEl = document.getElementById('executor-status');

executorSelect.addEventListener('change', async () => {
  const backend = executorSelect.value;
  permashipHint.classList.toggle('hidden', backend !== 'permaship');
  isExecutorNoop = (backend === 'noop');
  updateSettingsCue();

  // Save the setting
  try {
    const resp = await apiFetch('/api/settings/executor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend }),
    });
    const data = await resp.json();
    if (!data.success) {
      appendSystemMessage(`Failed to set executor: ${data.error}`);
      return;
    }
  } catch (err) {
    appendSystemMessage('Failed to update executor.');
    return;
  }

  // Test the backend
  await testExecutor(backend);
});

async function testExecutor(backend) {
  executorStatusEl.className = 'executor-status checking';
  executorStatusEl.textContent = 'Checking...';
  executorStatusEl.classList.remove('hidden');

  try {
    const resp = await apiFetch('/api/settings/executor/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend }),
    });
    const data = await resp.json();

    if (data.available) {
      executorStatusEl.className = 'executor-status ok';
      executorStatusEl.textContent = data.message;
      // Auto-hide success after a few seconds
      setTimeout(() => { if (executorStatusEl.classList.contains('ok')) executorStatusEl.classList.add('hidden'); }, 5000);
    } else {
      executorStatusEl.className = 'executor-status error';
      let html = escapeHtml(data.message);
      if (data.help) {
        // Convert URLs in help text to links
        const helpHtml = escapeHtml(data.help).replace(
          /(https?:\/\/[^\s]+)/g,
          '<a href="$1" target="_blank" rel="noopener">$1</a>'
        );
        html += '\n\n' + helpHtml;
      }
      executorStatusEl.innerHTML = html;
    }
  } catch (err) {
    executorStatusEl.className = 'executor-status error';
    executorStatusEl.textContent = 'Failed to test executor.';
  }
}

autonomousToggle.addEventListener('change', async () => {
  try {
    await apiFetch('/api/settings/autonomous', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: autonomousToggle.checked }),
    });
  } catch (err) {
    autonomousToggle.checked = !autonomousToggle.checked;
    appendSystemMessage('Failed to update autonomous mode.');
  }
});

if (worktreeToggle) {
  worktreeToggle.addEventListener('change', async () => {
    try {
      await apiFetch('/api/settings/worktrees', {
        method: 'POST',
        body: JSON.stringify({ enabled: worktreeToggle.checked }),
      });
    } catch (err) {
      worktreeToggle.checked = !worktreeToggle.checked;
      appendSystemMessage('Failed to update worktree setting.');
    }
  });
}

// ── Settings Panel ───────────────────────────────────────────────────────────

const settingsPanel = document.getElementById('settings-panel');
const settingsBtn = document.getElementById('settings-btn');
const settingsClose = document.getElementById('settings-close');

settingsBtn.addEventListener('click', () => {
  if (proposalsPanel && !proposalsPanel.classList.contains('hidden')) proposalsPanel.classList.add('hidden');
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    loadAgentSettings();
    loadKnowledge();
    loadHeartbeats();
  }
});

settingsClose.addEventListener('click', () => settingsPanel.classList.add('hidden'));

// Keyboard shortcuts: Cmd/Ctrl+Comma to toggle settings, Escape to close
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    settingsBtn.click();
  }
  if (e.key === 'Escape' && !settingsPanel.classList.contains('hidden')) {
    settingsPanel.classList.add('hidden');
  }
});

// Tab switching
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// Agent settings
const agentSettingsListEl = document.getElementById('agent-settings-list');

async function loadAgentSettings() {
  try {
    const resp = await apiFetch('/api/agents');
    const { agents } = await resp.json();
    agentSettingsListEl.innerHTML = '';
    for (const agent of agents) {
      const li = document.createElement('li');
      li.innerHTML = `
        <div>
          <span class="agent-name">${escapeHtml(agent.title)}</span>
          <span class="agent-summary-text">${escapeHtml(agent.summary || agent.id)}</span>
        </div>
        <label class="toggle">
          <input type="checkbox" ${agent.enabled ? 'checked' : ''} onchange="toggleAgent('${agent.id}', this.checked)">
          <span class="toggle-slider"></span>
        </label>
      `;
      agentSettingsListEl.appendChild(li);
    }
  } catch (err) {
    agentSettingsListEl.innerHTML = '<li style="color:var(--text-muted)">Failed to load agents</li>';
  }
}

async function toggleAgent(id, enabled) {
  try {
    await fetch(`/api/agents/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  } catch (err) {
    appendSystemMessage('Failed to toggle agent.');
  }
}

// Import agents — two-step: browse → select → import
const importBtn = document.getElementById('import-agents-btn');
const importForm = document.getElementById('import-agents-form');
const importFetch = document.getElementById('import-fetch');
const importCancel = document.getElementById('import-cancel');
const importUrlEl = document.getElementById('import-url');
const importPreview = document.getElementById('import-preview');
const importAgentList = document.getElementById('import-agent-list');
const importSelected = document.getElementById('import-selected');
const importSelectAll = document.getElementById('import-select-all');

let importCache = []; // cached preview results

importBtn.addEventListener('click', () => {
  importForm.classList.toggle('hidden');
  importPreview.classList.add('hidden');
  importAgentList.innerHTML = '';
});
importCancel.addEventListener('click', () => {
  importForm.classList.add('hidden');
  importPreview.classList.add('hidden');
});

// Step 1: Fetch available agents from repo
importFetch.addEventListener('click', async () => {
  const url = importUrlEl.value.trim();
  if (!url) return;
  importFetch.disabled = true;
  importFetch.textContent = 'Loading...';
  importAgentList.innerHTML = '';

  try {
    const resp = await apiFetch('/api/agents/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json();

    if (!data.success) {
      appendSystemMessage(`Browse failed: ${data.error}`);
      return;
    }

    importCache = data.agents;
    importPreview.classList.remove('hidden');
    importSelectAll.checked = false;

    let currentCategory = '';
    for (const agent of data.agents) {
      // Insert category header when category changes
      if (agent.category && agent.category !== currentCategory) {
        currentCategory = agent.category;
        const header = document.createElement('li');
        header.className = 'import-category-header';
        header.textContent = currentCategory.replace(/[-_]/g, ' ');
        importAgentList.appendChild(header);
      }

      const li = document.createElement('li');
      if (agent.alreadyImported) li.classList.add('already-imported');
      li.innerHTML = `
        <input type="checkbox" class="import-cb" data-id="${agent.id}" data-filename="${escapeHtml(agent.filename)}" data-url="${escapeHtml(agent.downloadUrl)}">
        <label>${escapeHtml(agent.title)}</label>
        ${agent.alreadyImported ? '<span class="import-badge">imported</span>' : ''}
      `;
      importAgentList.appendChild(li);
    }

    updateImportCount();
  } catch (err) {
    appendSystemMessage('Failed to fetch agents from repo.');
  } finally {
    importFetch.disabled = false;
    importFetch.textContent = 'Browse Agents';
  }
});

// Select all checkbox
function updateImportCount() {
  const checked = document.querySelectorAll('.import-cb:checked').length;
  importSelected.textContent = checked > 0 ? `Import Selected (${checked})` : 'Import Selected';
  importSelected.disabled = checked === 0;
}

importSelectAll.addEventListener('change', () => {
  document.querySelectorAll('.import-cb').forEach(cb => { cb.checked = importSelectAll.checked; });
  updateImportCount();
});

// Update count when any individual checkbox changes
importAgentList.addEventListener('change', updateImportCount);

// Import search filter
const importSearchEl = document.getElementById('import-search');
if (importSearchEl) {
  importSearchEl.addEventListener('input', () => {
    const q = importSearchEl.value.toLowerCase();
    importAgentList.querySelectorAll('li').forEach(li => {
      if (li.classList.contains('import-category-header')) { li.style.display = ''; return; }
      const label = li.querySelector('label');
      li.style.display = (!q || label?.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
  });
}

// Step 2: Import selected agents
importSelected.addEventListener('click', async () => {
  const checkboxes = document.querySelectorAll('.import-cb:checked');
  const selections = Array.from(checkboxes).map(cb => ({
    id: cb.dataset.id,
    filename: cb.dataset.filename,
    downloadUrl: cb.dataset.url,
  }));

  if (selections.length === 0) {
    appendSystemMessage('No agents selected.');
    return;
  }

  importSelected.disabled = true;
  importSelected.textContent = `Importing ${selections.length}...`;

  try {
    const resp = await apiFetch('/api/agents/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: selections }),
    });
    const data = await resp.json();

    if (data.success) {
      importForm.classList.add('hidden');
      importPreview.classList.add('hidden');
      let msg = `Imported ${data.imported} agent(s):`;
      if (data.names?.length) msg += '\n' + data.names.map(n => `  - ${n}`).join('\n');
      if (data.failed > 0) msg += `\n(${data.failed} failed)`;
      appendSystemMessage(msg);
      loadAgentSettings();
      loadAgents();
    } else {
      appendSystemMessage(`Import failed: ${data.error}`);
    }
  } catch (err) {
    appendSystemMessage('Import failed.');
  } finally {
    importSelected.disabled = false;
    importSelected.textContent = 'Import Selected';
  }
});

// Heartbeat settings
const heartbeatListEl = document.getElementById('heartbeat-list');
let heartbeatDebounce = {};

async function loadHeartbeats() {
  try {
    const resp = await apiFetch('/api/settings/heartbeats');
    const { heartbeats } = await resp.json();
    heartbeatListEl.innerHTML = '';
    for (const [key, hb] of Object.entries(heartbeats)) {
      const minutes = Math.round(hb.value / 60000);
      const row = document.createElement('div');
      row.className = 'heartbeat-row';
      row.innerHTML = `
        <span>${escapeHtml(hb.label)}</span>
        <div><input type="number" min="1" value="${minutes}" data-key="${key}" data-original="${hb.value}"> min</div>
      `;
      row.querySelector('input').addEventListener('input', (e) => {
        const input = e.target;
        const hbKey = input.dataset.key;
        clearTimeout(heartbeatDebounce[hbKey]);
        heartbeatDebounce[hbKey] = setTimeout(async () => {
          const val = parseInt(input.value, 10);
          if (isNaN(val) || val < 1) return;
          try {
            await apiFetch('/api/settings/heartbeats', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: hbKey, value: val * 60000 }),
            });
          } catch (err) { /* silent */ }
        }, 800);
      });
      heartbeatListEl.appendChild(row);
    }
  } catch (err) {
    heartbeatListEl.innerHTML = '<div style="color:var(--text-muted)">Failed to load</div>';
  }
}

// ── Knowledge Base ───────────────────────────────────────────────────────────

const kbTopicEl = document.getElementById('kb-topic');
const kbContentEl = document.getElementById('kb-content');
const kbSubmitEl = document.getElementById('kb-submit');
const kbEntriesEl = document.getElementById('kb-entries');

// Suggestion tags pre-fill the topic field
document.querySelectorAll('.kb-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    kbTopicEl.value = tag.dataset.topic;
    kbContentEl.focus();
  });
});

kbSubmitEl.addEventListener('click', async () => {
  const topic = kbTopicEl.value.trim();
  const content = kbContentEl.value.trim();
  if (!topic) { kbTopicEl.focus(); kbTopicEl.classList.add('input-error'); return; }
  if (!content) { kbContentEl.focus(); kbContentEl.classList.add('input-error'); return; }
  kbTopicEl.classList.remove('input-error');
  kbContentEl.classList.remove('input-error');

  kbSubmitEl.disabled = true;
  try {
    const resp = await apiFetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, content }),
    });
    const data = await resp.json();
    if (data.success) {
      kbTopicEl.value = '';
      kbContentEl.value = '';
      loadKnowledge();
    } else {
      appendSystemMessage(`Failed to add knowledge: ${data.error}`);
    }
  } catch (err) {
    appendSystemMessage('Failed to add knowledge entry.');
  } finally {
    kbSubmitEl.disabled = false;
  }
});

kbTopicEl.addEventListener('input', () => kbTopicEl.classList.remove('input-error'));
kbContentEl.addEventListener('input', () => kbContentEl.classList.remove('input-error'));

async function loadKnowledge() {
  try {
    const resp = await apiFetch('/api/knowledge');
    const { entries } = await resp.json();
    kbEntriesEl.innerHTML = '';

    if (entries.length === 0) {
      kbEntriesEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No knowledge entries yet. Add documents to help agents understand your team and projects.</div>';
      return;
    }

    for (const entry of entries) {
      const div = document.createElement('div');
      div.className = 'kb-entry';
      const preview = entry.content.length > 120 ? entry.content.slice(0, 120) + '...' : entry.content;
      const source = entry.sourceId ? `synced from project` : 'manual';
      div.innerHTML = `
        <div>
          <div class="kb-entry-topic">${escapeHtml(entry.topic)}</div>
          <div class="kb-entry-preview">${escapeHtml(preview)}</div>
          <div class="kb-entry-source">${source}</div>
        </div>
        <button class="remove-btn" onclick="removeKnowledge('${entry.id}')" title="Remove">&times;</button>
      `;
      kbEntriesEl.appendChild(div);
    }
  } catch (err) {
    kbEntriesEl.innerHTML = '<div style="color:var(--text-muted)">Failed to load</div>';
  }
}

async function removeKnowledge(id) {
  try {
    await fetch(`/api/knowledge/${id}`, { method: 'DELETE' });
    loadKnowledge();
  } catch (err) {
    appendSystemMessage('Failed to remove knowledge entry.');
  }
}

// ── Chat Form ────────────────────────────────────────────────────────────────

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (inputEl.value.trim()) {
      formEl.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }
});

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = inputEl.value.trim();
  if (!content) return;

  inputEl.value = '';
  inputEl.disabled = true;
  formEl.querySelector('button').disabled = true;

  try {
    const isMission = activeChannelId.startsWith('mission:');
    const missionId = isMission ? activeChannelId.replace('mission:', '') : null;
    const url = isMission ? `/api/missions/${missionId}/chat/send` : '/api/chat/send';
    await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    appendSystemMessage('Failed to send message.');
  } finally {
    inputEl.disabled = false;
    formEl.querySelector('button').disabled = false;
    inputEl.focus();
  }
});

// ── Setup Flow ───────────────────────────────────────────────────────────────

const setupOverlay = document.getElementById('setup-overlay');
const setupProviderEl = document.getElementById('setup-provider');
const setupApiKeyEl = document.getElementById('setup-api-key');
const setupKeyField = document.getElementById('setup-key-field');
const setupHintEl = document.getElementById('setup-hint');
const setupSubmitEl = document.getElementById('setup-submit');
const setupErrorEl = document.getElementById('setup-error');

const providerHints = {
  gemini: 'Get a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a>',
  anthropic: 'Get a key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>',
  openai: 'Get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>',
  ollama: 'Make sure Ollama is running locally on port 11434',
  openrouter: 'Get a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai</a>',
};

setupProviderEl.addEventListener('change', () => {
  const provider = setupProviderEl.value;
  if (provider === 'ollama') {
    setupKeyField.classList.add('hidden');
  } else {
    setupKeyField.classList.remove('hidden');
  }
  setupHintEl.innerHTML = providerHints[provider] || '';
});

setupSubmitEl.addEventListener('click', async () => {
  const provider = setupProviderEl.value;
  const apiKey = setupApiKeyEl.value.trim();

  if (provider !== 'ollama' && !apiKey) {
    setupErrorEl.textContent = 'Please enter your API key.';
    setupErrorEl.classList.remove('hidden');
    return;
  }

  setupSubmitEl.disabled = true;
  setupErrorEl.classList.add('hidden');

  try {
    const resp = await apiFetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey: apiKey || undefined }),
    });
    const data = await resp.json();

    if (data.success) {
      setupOverlay.classList.add('hidden');
      loadConfig();
      appendSystemMessage(`Nexus Command LLM provider set to "${provider}". You're all set! Try sending a message.`);
    } else {
      setupErrorEl.textContent = data.error || 'Setup failed.';
      setupErrorEl.classList.remove('hidden');
    }
  } catch (err) {
    setupErrorEl.textContent = 'Failed to connect to server.';
    setupErrorEl.classList.remove('hidden');
  } finally {
    setupSubmitEl.disabled = false;
  }
});

function showSetupIfNeeded(cfg) {
  if (cfg.needsSetup) {
    setupOverlay.classList.remove('hidden');
  } else {
    setupOverlay.classList.add('hidden');
  }
}

// ── Theme toggle ────────────────────────────────────────────────────────────

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  if (savedTheme === 'light') { document.documentElement.setAttribute('data-theme', 'light'); themeToggle.textContent = 'Dark'; }
  themeToggle.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    document.documentElement.toggleAttribute('data-theme');
    if (isLight) { document.documentElement.removeAttribute('data-theme'); themeToggle.textContent = 'Light'; localStorage.setItem('theme', 'dark'); }
    else { document.documentElement.setAttribute('data-theme', 'light'); themeToggle.textContent = 'Dark'; localStorage.setItem('theme', 'light'); }
  });
}

// ── Message search ──────────────────────────────────────────────────────────

const messageSearchEl = document.getElementById('message-search');
if (messageSearchEl) {
  messageSearchEl.addEventListener('input', () => {
    const q = messageSearchEl.value.toLowerCase();
    messagesEl.querySelectorAll('.message').forEach(msg => {
      const body = msg.querySelector('.body');
      if (!q) { msg.style.display = ''; msg.classList.remove('search-highlight'); return; }
      if (body?.textContent.toLowerCase().includes(q)) { msg.style.display = ''; msg.classList.add('search-highlight'); }
      else { msg.style.display = 'none'; msg.classList.remove('search-highlight'); }
    });
  });
}

// ── DOM message limit ───────────────────────────────────────────────────────

const MAX_DOM_MESSAGES = 500;
function trimOldMessages() {
  const msgs = messagesEl.querySelectorAll('.message');
  if (msgs.length > MAX_DOM_MESSAGES) {
    const toRemove = msgs.length - MAX_DOM_MESSAGES;
    for (let i = 0; i < toRemove; i++) msgs[i].remove();
  }
}

// ── Clear chat ──────────────────────────────────────────────────────────────

const clearChatBtn = document.getElementById('clear-chat');
if (clearChatBtn) {
  clearChatBtn.addEventListener('click', () => {
    if (!confirm('Clear all messages from this view? (History is preserved in the database)')) return;
    messagesEl.querySelectorAll('.message').forEach(m => m.remove());
    const es = document.getElementById('empty-state');
    if (es) es.classList.remove('hidden');
    lastAgentName = null;
  });
}

// ── Global Tooltip ───────────────────────────────────────────────────────────
const globalTooltip = document.createElement('div');
globalTooltip.id = 'agent-tooltip';
globalTooltip.className = 'global-agent-tooltip hidden';
globalTooltip.setAttribute('role', 'tooltip');
globalTooltip.setAttribute('aria-hidden', 'true');
document.body.appendChild(globalTooltip);

function showAgentTooltip(el, text) {
  globalTooltip.textContent = text;
  globalTooltip.classList.remove('hidden');
  globalTooltip.setAttribute('aria-hidden', 'false');
  
  const rect = el.getBoundingClientRect();
  const sidebarRect = document.getElementById('sidebar').getBoundingClientRect();
  
  // Position to the right of the sidebar, aligned vertically with the list item
  globalTooltip.style.top = `${rect.top}px`;
  globalTooltip.style.left = `${sidebarRect.right + 10}px`;
}

function hideAgentTooltip() {
  globalTooltip.classList.add('hidden');
  globalTooltip.setAttribute('aria-hidden', 'true');
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function loadAgents() {
  try {
    const resp = await apiFetch('/api/agents');
    const { agents } = await resp.json();
    agentListEl.innerHTML = '';
    for (const agent of agents) {
      const li = document.createElement('li');
      li.setAttribute('tabindex', '0');
      li.setAttribute('role', 'button');
      li.setAttribute('aria-describedby', 'agent-tooltip');
      li.className = 'agent-list-item';
      
      li.innerHTML = `<span class="agent-title">${escapeHtml(agent.title)}</span>`;
      
      // Tooltip events
      li.addEventListener('mouseenter', () => showAgentTooltip(li, agent.summary));
      li.addEventListener('mouseleave', hideAgentTooltip);
      li.addEventListener('focus', () => showAgentTooltip(li, agent.summary));
      li.addEventListener('blur', hideAgentTooltip);
      
      // Click-to-mention
      li.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        const val = input.value;
        const prefix = val.length > 0 && !val.endsWith(' ') && !val.endsWith('\n') ? ' ' : '';
        input.value = val + prefix + `@${agent.id} `;
        input.focus();
      });
      
      // Keyboard selection (Enter/Space)
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          li.click();
        }
      });
      
      agentListEl.appendChild(li);
    }
  } catch (err) {
    // Agents not loaded yet — will retry on reconnect
  }
}

async function loadHistory() {
  try {
    const isMission = activeChannelId.startsWith('mission:');
    const missionId = isMission ? activeChannelId.replace('mission:', '') : null;
    const url = isMission ? `/api/missions/${missionId}/chat?limit=50` : '/api/chat/history?limit=50';
    const resp = await apiFetch(url);
    const { messages } = await resp.json();
    for (const msg of messages) {
      appendHistoryMessage(msg);
    }
    scrollToBottom();
  } catch (err) {
    // History load failed — not critical
  }
}

// ── Mission Management ──────────────────────────────────────────────────────

const missionListEl = document.getElementById('mission-list');
const missionModal = document.getElementById('mission-modal');
const missionChecklistEl = document.getElementById('mission-checklist');
const tabBar = document.getElementById('tab-bar');

async function loadMissions() {
  try {
    const resp = await apiFetch('/api/missions');
    const data = await resp.json();
    missions = data.missions || [];
    renderMissionList();
    renderMissionTabs();
  } catch { /* not critical */ }
}

function renderMissionList() {
  if (!missionListEl) return;
  missionListEl.innerHTML = '';
  for (const m of missions) {
    const li = document.createElement('li');
    li.className = activeChannelId === m.channelId ? 'active-mission' : '';
    li.innerHTML = `<span class="mission-title-text">${escapeHtml(m.title)}</span><span class="mission-status-dot ${m.status}"></span>`;
    li.addEventListener('click', () => switchToChannel(m.channelId));
    missionListEl.appendChild(li);
  }
}

function renderMissionTabs() {
  if (!tabBar) return;
  // Remove old mission tabs
  tabBar.querySelectorAll('.chat-tab[data-channel^="mission:"]').forEach(t => t.remove());
  // Add tabs for active missions
  for (const m of missions) {
    if (m.status === 'completed' || m.status === 'cancelled') continue;
    const btn = document.createElement('button');
    btn.className = 'chat-tab' + (activeChannelId === m.channelId ? ' active' : '');
    btn.dataset.channel = m.channelId;
    btn.textContent = m.title.length > 20 ? m.title.slice(0, 20) + '...' : m.title;
    btn.addEventListener('click', () => switchToChannel(m.channelId));
    tabBar.appendChild(btn);
  }
  // Update General tab active state
  const generalTab = tabBar.querySelector('[data-channel="local:general"]');
  if (generalTab) generalTab.className = 'chat-tab' + (activeChannelId === 'local:general' ? ' active' : '');
}

function switchToChannel(channelId) {
  if (channelId === activeChannelId) return;
  activeChannelId = channelId;
  lastAgentName = null;

  // Clear messages
  messagesEl.innerHTML = '';
  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.remove();

  // Update tab bar
  tabBar.querySelectorAll('.chat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.channel === channelId);
  });

  // Update mission list highlights
  renderMissionList();

  // Show/hide checklist
  if (channelId.startsWith('mission:')) {
    loadMissionChecklist(channelId.replace('mission:', ''));
  } else {
    if (missionChecklistEl) missionChecklistEl.classList.add('hidden');
  }

  // Load history for new channel
  loadHistory();
}

async function loadMissionChecklist(missionId) {
  try {
    const resp = await apiFetch(`/api/missions/${missionId}`);
    const data = await resp.json();
    if (!data.mission || !missionChecklistEl) return;

    const items = data.items || [];
    if (items.length === 0) {
      missionChecklistEl.classList.add('hidden');
      return;
    }

    const mId = data.mission.id;
    const autoVal = data.mission.autonomousMode;
    let html = `<h4>Checklist — ${escapeHtml(data.mission.title)}</h4>`;
    html += `<div style="margin-bottom:8px;font-size:12px;display:flex;align-items:center;gap:6px">`;
    html += `<span style="color:var(--text-muted)">Autonomous:</span>`;
    html += `<select class="config-select" style="font-size:11px;padding:2px 4px" onchange="setMissionAutonomous('${mId}',this.value)">`;
    html += `<option value="null"${autoVal == null ? ' selected' : ''}>Inherit</option>`;
    html += `<option value="true"${autoVal === true ? ' selected' : ''}>On</option>`;
    html += `<option value="false"${autoVal === false ? ' selected' : ''}>Off</option>`;
    html += `</select></div>`;
    for (const item of items) {
      const marker = item.status === 'verified' ? '[x]'
        : item.status === 'agent_complete' ? '[?]'
        : item.status === 'in_progress' ? '[~]' : '[ ]';
      const markerClass = item.status === 'verified' ? 'verified'
        : item.status === 'agent_complete' ? 'agent-complete'
        : item.status === 'in_progress' ? 'in-progress' : '';
      const textClass = item.status === 'verified' ? 'verified' : '';
      html += `<div class="checklist-item"><span class="checklist-marker ${markerClass}">${marker}</span><span class="checklist-text ${textClass}">${escapeHtml(item.title)}</span></div>`;
    }
    missionChecklistEl.innerHTML = html;
    missionChecklistEl.classList.remove('hidden');
  } catch { /* not critical */ }
}

// General tab click
if (tabBar) {
  const generalTab = tabBar.querySelector('[data-channel="local:general"]');
  if (generalTab) {
    generalTab.addEventListener('click', () => switchToChannel('local:general'));
  }
}

// New mission button
const newMissionBtn = document.getElementById('new-mission-btn');
if (newMissionBtn) {
  newMissionBtn.addEventListener('click', async () => {
    // Load projects into checkboxes
    const checkboxContainer = document.getElementById('mission-project-checkboxes');
    if (checkboxContainer) {
      try {
        const resp = await apiFetch('/api/projects');
        const { projects } = await resp.json();
        checkboxContainer.innerHTML = projects.length > 0
          ? projects.map(p => `<label><input type="checkbox" value="${p.id}"> ${escapeHtml(p.name)}</label>`).join('')
          : '<span style="color:var(--text-muted);font-size:11px">No projects added yet</span>';
      } catch {
        checkboxContainer.innerHTML = '';
      }
    }
    document.getElementById('mission-title').value = '';
    document.getElementById('mission-desc').value = '';
    document.getElementById('mission-error').classList.add('hidden');
    missionModal.classList.remove('hidden');
  });
}

// Cancel mission creation
const missionCancelBtn = document.getElementById('mission-cancel-btn');
if (missionCancelBtn) {
  missionCancelBtn.addEventListener('click', () => missionModal.classList.add('hidden'));
}

// Create mission
const missionCreateBtn = document.getElementById('mission-create-btn');
if (missionCreateBtn) {
  missionCreateBtn.addEventListener('click', async () => {
    const title = document.getElementById('mission-title').value.trim();
    const description = document.getElementById('mission-desc').value.trim();
    const errorEl = document.getElementById('mission-error');

    if (!title || !description) {
      errorEl.textContent = 'Title and description are required';
      errorEl.classList.remove('hidden');
      return;
    }

    const checkboxes = document.querySelectorAll('#mission-project-checkboxes input:checked');
    const projectIds = Array.from(checkboxes).map(cb => cb.value);
    const autonomousEl = document.getElementById('mission-autonomous');
    const autonomousMode = autonomousEl && autonomousEl.checked ? true : null;

    missionCreateBtn.disabled = true;
    try {
      const resp = await apiFetch('/api/missions', {
        method: 'POST',
        body: JSON.stringify({ title, description, projectIds, autonomousMode }),
      });
      const data = await resp.json();
      if (data.success) {
        missionModal.classList.add('hidden');
        await loadMissions();
        switchToChannel(data.mission.channelId);
      } else {
        errorEl.textContent = data.error || 'Failed to create mission';
        errorEl.classList.remove('hidden');
      }
    } catch {
      errorEl.textContent = 'Network error';
      errorEl.classList.remove('hidden');
    } finally {
      missionCreateBtn.disabled = false;
    }
  });
}

// Close modal on overlay click
if (missionModal) {
  missionModal.addEventListener('click', (e) => {
    if (e.target === missionModal) missionModal.classList.add('hidden');
  });
}

// Boot
const loadingOverlay = document.getElementById('loading-overlay');

// Fetch session token before any API calls
initAuth().then(() => {
  loadAgents();
  loadProjects();
  loadMissions();
  loadConfig();
  return loadHistory();
}).then(() => {
  if (loadingOverlay) loadingOverlay.classList.add('hidden');
  if (messagesEl.querySelectorAll('.message').length > 0) hideEmptyState();
  if (messagesEl.children.length === 0) {
    appendSystemMessage(
      'Welcome to Nexus Command!\n\n' +
      'You have a team of 10 AI specialist agents ready to help — a CISO, SRE, QA Manager, Product Manager, and more. ' +
      'Your messages are automatically routed to the right specialist.\n\n' +
      'To get started:\n' +
      '  1. Type a message below to chat with the team\n' +
      '  2. Click "+ Add Project" in the sidebar to connect a codebase\n' +
      '  3. Once a project is connected, agents can review code and propose tickets\n\n' +
      'Tip: Agents will propose tickets that go through a review process. You can approve or reject them with the buttons that appear.'
    );
  }
  connect();
});
