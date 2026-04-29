const $ = (id) => document.getElementById(id);
const log = (m) => { $('log').textContent += m + '\n'; $('log').scrollTop = 1e9; };

const today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
$('date').value = today.toISOString().slice(0,10);

function gqlUrl()   { return `https://new.simpleonboarding.com.au/${$('tenant').value.trim()}/graphql`; }

async function gql(operationName, query, variables) {
  const r = await fetch(gqlUrl(), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'accept': '*/*' },
    body: JSON.stringify({ operationName, query, variables })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

let allTasks = [];
let selectedTaskKey = null;

const taskKey = (s) => `${s.entityType}:${s.entityId}:${s.organizationId}`;

function renderTasks(filter) {
  const list = $('task');
  const q = (filter || '').trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  list.innerHTML = '';
  const matches = allTasks.filter(s => tokens.every(t => s._search.includes(t)));

  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = allTasks.length ? '— no matches —' : '— loading —';
    list.appendChild(empty);
    return;
  }

  if (!matches.some(s => taskKey(s) === selectedTaskKey)) {
    selectedTaskKey = taskKey(matches[0]);
  }

  for (const s of matches) {
    const item = document.createElement('div');
    item.className = 'item';
    item.role = 'option';
    const key = taskKey(s);
    item.dataset.key = key;
    if (key === selectedTaskKey) item.classList.add('selected');
    item.title = `${s.organizationName} / ${s.projectName} — ${s.entityName}`;

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.entityName;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${s.organizationName} / ${s.projectName}`;
    item.append(name, meta);

    item.addEventListener('click', () => {
      selectedTaskKey = key;
      for (const el of list.querySelectorAll('.item.selected')) el.classList.remove('selected');
      item.classList.add('selected');
    });
    list.appendChild(item);
  }
}

function getSelectedTask() {
  const s = allTasks.find(t => taskKey(t) === selectedTaskKey);
  if (!s) throw new Error('Pick a task first');
  return { entityType: s.entityType, entityId: s.entityId, organizationID: s.organizationId };
}

async function loadTasks() {
  try {
    const data = await gql(
      'GetTimelogSuggestions',
      `query GetTimelogSuggestions($limit: Int) {
         timelogSuggestions(limit: $limit) {
           entityType entityId entityName organizationId organizationName projectName
         }
       }`,
      { limit: 200 }
    );
    allTasks = data.timelogSuggestions.map(s => ({
      ...s,
      _search: `${s.organizationName} ${s.projectName} ${s.entityName}`.toLowerCase()
    }));
    renderTasks($('taskSearch').value);
  } catch (e) {
    log('Failed to load tasks: ' + e.message + '\nMake sure you are logged in.');
  }
}
loadTasks();

$('taskSearch').addEventListener('input', (e) => renderTasks(e.target.value));

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  $('log').textContent = '';
  try {
    const total = (parseInt($('hours').value,10)||0)*60 + (parseInt($('mins').value,10)||0);
    if (total <= 0) throw new Error('Total time must be > 0');
    const task = getSelectedTask();
    const date = $('date').value;
    const billable = $('billable').checked;
    const batchSize = Math.max(1, parseInt($('batch').value,10) || 60);

    const CHUNK_MINUTES = 90;
    const baseTemplate = {
      logDate: date, notes: '', isBillable: billable,
      entityType: task.entityType, entityId: task.entityId, organizationID: task.organizationID
    };

    const fullChunks = Math.floor(total / CHUNK_MINUTES);
    const remainder = total % CHUNK_MINUTES;
    const allInputs = [
      ...Array.from({length: fullChunks}, () => ({...baseTemplate, timeSpentMinutes: CHUNK_MINUTES})),
      ...(remainder > 0 ? [{...baseTemplate, timeSpentMinutes: remainder}] : [])
    ];

    log(`Creating ${fullChunks} × 90-minute log${fullChunks === 1 ? '' : 's'}${remainder > 0 ? ` + 1 × ${remainder}-minute log` : ''} on ${date}…`);

    const mutation = `mutation CreateTimeLogs($inputs: [TimeLogInput!]!) {
      createTimeLogs(inputs: $inputs) { id timeSpentMinutes }
    }`;

    let done = 0;
    while (done < allInputs.length) {
      const inputs = allInputs.slice(done, done + batchSize);
      await gql('CreateTimeLogs', mutation, { inputs });
      done += inputs.length;
      log(`  …${done}/${allInputs.length}`);
    }
    log('Done ✅');
  } catch (e) {
    log('Error: ' + e.message);
  } finally {
    $('go').disabled = false;
  }
});