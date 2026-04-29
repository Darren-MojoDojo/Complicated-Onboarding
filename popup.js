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

let allSuggestions = [];
let currentTasks = [];
let selectedTaskKey = null;
const projectsByOrg = {};
let emptyMessage = '— loading —';
let currentProjectID = null;
let currentProjectName = '';
let currentOrgName = '';

const taskKey = (s) => `${s.entityType}:${s.entityId}:${s.organizationID}`;

const normalize = (entityType, entityId, organizationID, name, org, project) => ({
  entityType, entityId, organizationID, name, org, project,
  _search: `${org} ${project} ${name}`.toLowerCase()
});

function buildCreateRow() {
  const row = document.createElement('div');
  row.className = 'create-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '+ New task title…';
  const btn = document.createElement('button');
  btn.textContent = 'Create';
  const submit = async () => {
    const title = input.value.trim();
    if (!title || !currentProjectID) return;
    btn.disabled = true;
    input.disabled = true;
    try {
      await createTaskInCurrentProject(title);
    } catch (err) {
      log('Failed to create task: ' + err.message);
      btn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  row.append(input, btn);
  return row;
}

async function createTaskInCurrentProject(title) {
  const data = await gql(
    'CreateTask',
    `mutation CreateTask($input: CreateTaskInput!) {
       createTask(input: $input) { id title organizationID }
     }`,
    { input: { title, description: '', status: 'To Do', priority: 'Medium', assigneeId: null, projectID: currentProjectID } }
  );
  const t = data.createTask;
  const newTask = normalize('tasks', t.id, t.organizationID, t.title, currentOrgName, currentProjectName);
  currentTasks = [newTask, ...currentTasks].sort((a, b) => a.name.localeCompare(b.name));
  selectedTaskKey = taskKey(newTask);
  renderTasks($('taskSearch').value);
  log(`Created task: ${t.title}`);
}

function renderTasks(filter) {
  const list = $('task');
  const q = (filter || '').trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  list.innerHTML = '';

  if (currentProjectID) list.appendChild(buildCreateRow());

  const matches = currentTasks.filter(s => tokens.every(t => s._search.includes(t)));

  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = currentTasks.length ? '— no matches —' : emptyMessage;
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
    item.title = `${s.org} / ${s.project} — ${s.name}`;

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${s.org} / ${s.project}`;
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
  const s = currentTasks.find(t => taskKey(t) === selectedTaskKey);
  if (!s) throw new Error('Pick a task first');
  return { entityType: s.entityType, entityId: s.entityId, organizationID: s.organizationID };
}

function populateOrgDropdown() {
  const orgs = new Map();
  for (const s of allSuggestions) orgs.set(s.organizationID, s.org);
  const sorted = [...orgs.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const sel = $('org');
  sel.innerHTML = '<option value="">— Recent tasks —</option>';
  for (const [id, name] of sorted) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    sel.appendChild(opt);
  }
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
    allSuggestions = data.timelogSuggestions.map(s =>
      normalize(s.entityType, s.entityId, s.organizationId, s.entityName, s.organizationName, s.projectName)
    );
    currentTasks = allSuggestions;
    emptyMessage = '— no suggestions —';
    populateOrgDropdown();
    renderTasks($('taskSearch').value);
  } catch (e) {
    emptyMessage = '— failed to load —';
    renderTasks($('taskSearch').value);
    log('Failed to load tasks: ' + e.message + '\nMake sure you are logged in.');
  }
}
$('taskSearch').addEventListener('input', (e) => renderTasks(e.target.value));

$('settingsBtn').addEventListener('click', () => $('settingsModal').showModal());
$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal')) $('settingsModal').close();
});

const SETTINGS_KEYS = ['tenant', 'batch', 'splitMinutes'];

async function loadSettings() {
  if (!chrome?.storage?.local) return;
  const stored = await chrome.storage.local.get(SETTINGS_KEYS);
  for (const key of SETTINGS_KEYS) {
    const v = stored[key];
    if (v !== undefined && v !== '') $(key).value = v;
  }
}

function persistSetting(key) {
  if (!chrome?.storage?.local) return;
  chrome.storage.local.set({ [key]: $(key).value });
}

for (const key of SETTINGS_KEYS) {
  $(key).addEventListener('input', () => persistSetting(key));
}

(async () => {
  await loadSettings();
  loadTasks();
})();

$('org').addEventListener('change', async (e) => {
  const orgId = e.target.value;
  const projSel = $('project');
  currentProjectID = null;
  if (!orgId) {
    projSel.innerHTML = '<option value="">— pick an organization —</option>';
    projSel.disabled = true;
    currentTasks = allSuggestions;
    emptyMessage = '— no suggestions —';
    renderTasks($('taskSearch').value);
    return;
  }
  projSel.disabled = true;
  projSel.innerHTML = '<option value="">— loading —</option>';
  currentTasks = [];
  emptyMessage = '— pick a project —';
  renderTasks($('taskSearch').value);
  try {
    if (!projectsByOrg[orgId]) {
      const data = await gql(
        'SplitterOrgProjects',
        `query SplitterOrgProjects($id: ID!) {
           organization(id: $id) { id name projects { id name } }
         }`,
        { id: orgId }
      );
      const projects = (data.organization?.projects || [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      projectsByOrg[orgId] = { name: data.organization?.name || '', projects };
    }
    const { projects } = projectsByOrg[orgId];
    projSel.innerHTML = '<option value="">— pick a project —</option>';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      projSel.appendChild(opt);
    }
    projSel.disabled = false;
  } catch (err) {
    projSel.innerHTML = '<option value="">— error —</option>';
    log('Failed to load projects: ' + err.message);
  }
});

$('project').addEventListener('change', async (e) => {
  const projectID = e.target.value;
  if (!projectID) {
    currentProjectID = null;
    currentTasks = [];
    emptyMessage = '— pick a project —';
    renderTasks($('taskSearch').value);
    return;
  }
  const projectName = e.target.options[e.target.selectedIndex].textContent;
  const orgSel = $('org');
  const orgName = orgSel.options[orgSel.selectedIndex].textContent;
  currentProjectID = projectID;
  currentProjectName = projectName;
  currentOrgName = orgName;
  currentTasks = [];
  emptyMessage = '— loading tasks —';
  renderTasks($('taskSearch').value);
  try {
    const data = await gql(
      'SplitterProjectTasks',
      `query SplitterProjectTasks($projectID: ID!) {
         projectData(projectID: $projectID) {
           tasks { id title organizationID }
         }
       }`,
      { projectID }
    );
    const tasks = data.projectData?.tasks || [];
    currentTasks = tasks
      .map(t => normalize('tasks', t.id, t.organizationID, t.title, orgName, projectName))
      .sort((a, b) => a.name.localeCompare(b.name));
    emptyMessage = '— no tasks in this project —';
    renderTasks($('taskSearch').value);
  } catch (err) {
    emptyMessage = '— error —';
    renderTasks($('taskSearch').value);
    log('Failed to load project tasks: ' + err.message);
  }
});

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

    const chunkMinutes = Math.max(1, parseInt($('splitMinutes').value, 10) || 90);
    const wasSplit = total > chunkMinutes;
    const baseTemplate = {
      logDate: date,
      notes: wasSplit ? `task needed more than ${chunkMinutes} minutes to do` : '',
      isBillable: billable,
      entityType: task.entityType, entityId: task.entityId, organizationID: task.organizationID
    };

    const fullChunks = Math.floor(total / chunkMinutes);
    const remainder = total % chunkMinutes;
    const allInputs = [
      ...Array.from({length: fullChunks}, () => ({...baseTemplate, timeSpentMinutes: chunkMinutes})),
      ...(remainder > 0 ? [{...baseTemplate, timeSpentMinutes: remainder}] : [])
    ];

    log(`Creating ${fullChunks} × ${chunkMinutes}-minute log${fullChunks === 1 ? '' : 's'}${remainder > 0 ? ` + 1 × ${remainder}-minute log` : ''} on ${date}…`);

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