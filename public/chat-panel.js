export function createChatPanel() {
  const $ = id => document.getElementById(id);
  function show(open, focus = false) {
    $('workspace').classList.toggle('chat-collapsed', !open);
    $('sitecad-chat-panel').hidden = !open;
    $('chat-expand').hidden = open;
    for (const id of ['chat-expand', 'chat-collapse']) $(id).setAttribute('aria-expanded', String(open));
    if (focus) (open ? $('chat-collapse') : $('chat-expand')).focus();
  }
  $('chat-collapse').addEventListener('click', () => show(false, true));
  $('chat-expand').addEventListener('click', () => show(true, true));
  return { update(status) { if (status.approvals?.length) show(true); } };
}
