const ws = new WebSocket(`ws://${location.host}`);
const consoleContainer = document.getElementById('console');
const statusBadge = document.getElementById('status-badge');
const currentServerId = window.SERVER_ID;

function toggleMenu() {
  document.getElementById('sidebar').classList.toggle('active');
  document.getElementById('overlay').classList.toggle('active');
}

ws.onopen = () => {
  if (currentServerId) {
    ws.send(JSON.stringify({ action: 'REGISTER', serverId: currentServerId }));
  }
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'history') {
    if (consoleContainer) consoleContainer.innerHTML = '';
    message.logs.forEach(log => appendLog(log));
  } else if (message.type === 'log') {
    appendLog(message.data);
  } else if (message.type === 'status') {
    if (statusBadge) {
      statusBadge.textContent = message.status;
      statusBadge.className = `status-badge ${message.status}`;
    }
  }
};

function appendLog(text) {
  if (!consoleContainer) return;
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = text;
  consoleContainer.appendChild(line);
  consoleContainer.scrollTop = consoleContainer.scrollHeight;
}

function sendAction(action) {
  ws.send(JSON.stringify({ action }));
}

function deleteSelectedFiles() {
  const checkboxes = document.querySelectorAll('.file-checkbox:checked');
  const filenames = Array.from(checkboxes).map(cb => cb.value);

  if (filenames.length === 0) return alert('Select files first!');

  if (confirm(`Delete ${filenames.length} file(s)?`)) {
    fetch(`/server/${currentServerId}/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames })
    }).then(() => location.reload());
  }
}
