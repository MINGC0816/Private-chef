(() => {
  const API = {
    presign: "/api/v1/oss/presign",
    stream: "/api/v1/chat/stream",
    messages: "/api/v1/chat/messages",
    threads: "/api/v1/threads",
    pantry: "/api/v1/pantry",
    pantryRemove: "/api/v1/pantry/remove",
    profile: "/api/v1/profile",
  };

  const STORAGE_KEY = "personal-chief-thread";

  const els = {
    shell: document.querySelector(".shell"),
    sidebar: document.getElementById("sidebar"),
    sidebarBackdrop: document.getElementById("sidebarBackdrop"),
    menuBtn: document.getElementById("menuBtn"),
    stage: document.getElementById("stage"),
    welcome: document.getElementById("welcome"),
    messages: document.getElementById("messages"),
    messageInput: document.getElementById("messageInput"),
    sendBtn: document.getElementById("sendBtn"),
    actionBtn: document.getElementById("sendBtn"),
    actionSendIcon: document.querySelector("#sendBtn .icon-send"),
    actionStopIcon: document.querySelector("#sendBtn .icon-stop"),
    sendLabel: document.getElementById("sendLabel"),
    pickImageBtn: document.getElementById("pickImageBtn"),
    fileInput: document.getElementById("fileInput"),
    preview: document.getElementById("preview"),
    previewImg: document.getElementById("previewImg"),
    removeImageBtn: document.getElementById("removeImageBtn"),
    sidebarNewChatBtn: document.getElementById("sidebarNewChatBtn"),
    sidebarKicker: document.getElementById("sidebarKicker"),
    sidebarTitle: document.getElementById("sidebarTitle"),
    threadNav: document.getElementById("threadNav"),
    threadEmpty: document.getElementById("threadEmpty"),
    panelThreads: document.getElementById("panelThreads"),
    panelPantry: document.getElementById("panelPantry"),
    panelProfile: document.getElementById("panelProfile"),
    pantryEmpty: document.getElementById("pantryEmpty"),
    pantryList: document.getElementById("pantryList"),
    pantryAddForm: document.getElementById("pantryAddForm"),
    pantryNameInput: document.getElementById("pantryNameInput"),
    pantryCategorySelect: document.getElementById("pantryCategorySelect"),
    profileForm: document.getElementById("profileForm"),
    profileSaved: document.getElementById("profileSaved"),
    threadLabel: document.getElementById("threadLabel"),
    chatTitle: document.getElementById("chatTitle"),
    composer: document.getElementById("composer"),
  };

  const state = {
    threadId: createThreadId(),
    threads: [],
    pendingFile: null,
    pendingPreviewUrl: null,
    busy: false,
    abortController: null,
    pantry: [],
    sidebarPanel: "threads",
  };

  if (window.marked) {
    marked.setOptions({ breaks: true, gfm: true });
  }

  function createThreadId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function fetchThreads() {
    const res = await fetch(API.threads);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.threads) ? data.threads : [];
  }

  async function refreshThreads() {
    try {
      state.threads = await fetchThreads();
    } catch {
      // keep current cache
    }
    renderThreadList();
    updateHeader();
  }

  function upsertLocalThread(threadId, opts = {}) {
    const title = typeof opts.title === "string" ? opts.title.trim().slice(0, 32) : "";
    const idx = state.threads.findIndex((t) => t.id === threadId);
    const prev = idx >= 0 ? state.threads[idx] : null;
    const next = {
      id: threadId,
      title: prev?.title || "新对话",
      updated_at: Date.now(),
      manual_title: Boolean(prev?.manual_title),
      auto_titled: Boolean(prev?.auto_titled),
    };
    if (opts.manual && title) {
      next.title = title;
      next.manual_title = true;
    } else if (opts.autoTitled && title && !next.manual_title) {
      next.title = title;
      next.auto_titled = true;
    } else if (title && !next.manual_title && !next.auto_titled) {
      next.title = title;
    }
    if (idx >= 0) state.threads[idx] = next;
    else state.threads.unshift(next);
    state.threads.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }

  async function patchThread(threadId, body) {
    await fetch(`${API.threads}/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function renameThread(threadId, title) {
    const next = (title || "").trim().slice(0, 32);
    if (!next) return;
    upsertLocalThread(threadId, { title: next, manual: true });
    updateHeader();
    renderThreadList();
    try {
      await patchThread(threadId, { title: next, manual: true });
      await refreshThreads();
    } catch {
      // keep optimistic title
    }
  }

  /** 根据用户问题与助手回复，总结短会话名（本地规则，无需额外模型调用） */
  function summarizeConversationTitle(userText, assistantText) {
    const user = String(userText || "").replace(/\s+/g, " ").trim();
    const assistant = String(assistantText || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/[#>*_`|-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const foods = [
      "鸡蛋", "番茄", "西红柿", "青椒", "土豆", "牛肉", "猪肉", "鸡肉", "鱼", "虾",
      "白菜", "豆腐", "茄子", "黄瓜", "洋葱", "大蒜", "排骨", "米饭", "面条", "西兰花",
      "胡萝卜", "芹菜", "蘑菇", "香菇", "玉米", "南瓜", "韭菜", "豆芽", "羊肉", "鸭肉",
    ];
    const foundFoods = foods.filter((f) => user.includes(f) || assistant.includes(f));

    const dishMatch =
      assistant.match(/(?:推荐|道[：:]?\s*)([^\n，。！？]{2,12}?)(?:\s|$|，|。|！|？|\*|（|\()/ ) ||
      assistant.match(/\*\*([^*]{2,16})\*\*/) ||
      assistant.match(/《([^》]{2,16})》/);

    if (foundFoods.length && dishMatch?.[1]) {
      const dish = dishMatch[1].replace(/推荐|食谱|菜谱/g, "").trim();
      if (dish) return `${foundFoods.slice(0, 2).join("·")} · ${dish}`.slice(0, 32);
    }
    if (foundFoods.length) {
      return `${foundFoods.slice(0, 3).join("、")}怎么做`.slice(0, 32);
    }
    if (dishMatch?.[1]) {
      return dishMatch[1].replace(/推荐|食谱|菜谱/g, "").trim().slice(0, 32);
    }

    let seed = user
      .replace(/^请根据这张食材图片推荐菜谱$/, "食材图片荐菜")
      .replace(/请|帮我|一下|推荐|菜谱|食谱/g, "")
      .trim();
    if (!seed || seed.length < 2) {
      seed = assistant.slice(0, 24) || "新对话";
    }
    if (seed.length > 18) seed = `${seed.slice(0, 18)}…`;
    return seed.slice(0, 32) || "新对话";
  }

  function applyAutoTitle(threadId, userText, assistantText) {
    const item = state.threads.find((t) => t.id === threadId);
    if (item?.manual_title || item?.auto_titled) return;
    const title = summarizeConversationTitle(userText, assistantText);
    upsertLocalThread(threadId, { title, autoTitled: true });
    updateHeader();
    renderThreadList();
    patchThread(threadId, { title, auto_titled: true }).catch(() => {});
  }

  function currentMeta() {
    return state.threads.find((t) => t.id === state.threadId);
  }

  function updateHeader() {
    const meta = currentMeta();
    const short = state.threadId.slice(0, 8);
    if (els.chatTitle) {
      els.chatTitle.textContent = meta?.title || "新对话";
      els.chatTitle.title = "点击重命名当前会话";
    }
    if (els.threadLabel) {
      els.threadLabel.textContent = `会话 ${short}`;
    }
  }

  function formatTime(ts) {
    try {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      if (sameDay) {
        return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      }
      return d.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function iconSvg(name) {
    if (name === "rename") {
      return (
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">` +
        `<path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0-3-3L5.2 17V20Z"/>` +
        `<path d="m14.2 6.2 3.6 3.6"/>` +
        `</svg>`
      );
    }
    return (
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">` +
      `<path d="M5 7h14"/>` +
      `<path d="M10 7V5.8c0-.4.3-.8.8-.8h2.4c.4 0 .8.4.8.8V7"/>` +
      `<path d="m8.2 7 .8 12.2c0 .6.5 1 1.1 1h3.8c.6 0 1.1-.4 1.1-1L16 7"/>` +
      `</svg>`
    );
  }

  function findThreadRow(threadId) {
    return els.threadNav?.querySelector(`.thread-item[data-thread-id="${CSS.escape(threadId)}"]`);
  }

  function startRename(threadId) {
    if (els.threadNav?.querySelector(".is-renaming, .is-confirming")) {
      renderThreadList();
    }
    const meta = state.threads.find((t) => t.id === threadId);
    const row = findThreadRow(threadId);
    const titleSpan = row?.querySelector(".thread-title");
    if (!meta || !row || !titleSpan) return;

    row.classList.add("is-renaming");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "thread-rename-input";
    input.value = meta.title || "";
    input.maxLength = 32;
    input.setAttribute("aria-label", "重命名会话");

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const val = input.value.trim();
      if (commit && val && val !== meta.title) renameThread(threadId, val);
      else renderThreadList();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true));

    titleSpan.replaceWith(input);
    input.focus();
    input.select();
  }

  function startDelete(threadId) {
    if (els.threadNav?.querySelector(".is-renaming, .is-confirming")) {
      renderThreadList();
    }
    const row = findThreadRow(threadId);
    if (!row) return;

    row.classList.add("is-confirming");
    const main = row.querySelector(".thread-main");
    const actions = row.querySelector(".thread-actions");
    if (main) main.hidden = true;
    if (actions) actions.hidden = true;

    const bar = document.createElement("div");
    bar.className = "thread-confirm";
    bar.innerHTML =
      `<p>确认删除？</p>` +
      `<div class="thread-confirm-btns">` +
      `<button type="button" class="thread-confirm-no">取消</button>` +
      `<button type="button" class="thread-confirm-yes">删除</button>` +
      `</div>`;
    bar.querySelector(".thread-confirm-no").addEventListener("click", (e) => {
      e.stopPropagation();
      renderThreadList();
    });
    bar.querySelector(".thread-confirm-yes").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteThread(threadId);
    });
    row.appendChild(bar);
  }

  function splitTags(text) {
    return String(text || "")
      .split(/[,，、]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function joinTags(values) {
    return Array.isArray(values) ? values.join("，") : "";
  }

  function setSidebarPanel(name) {
    state.sidebarPanel = name;
    document.querySelectorAll(".sidebar-tab").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.panel === name);
    });
    if (els.panelThreads) els.panelThreads.hidden = name !== "threads";
    if (els.panelPantry) els.panelPantry.hidden = name !== "pantry";
    if (els.panelProfile) els.panelProfile.hidden = name !== "profile";
    if (els.sidebarNewChatBtn) els.sidebarNewChatBtn.hidden = name !== "threads";
    const titles = {
      threads: ["History", "历史会话"],
      pantry: ["Pantry", "我的冰箱"],
      profile: ["Taste", "我的口味"],
    };
    const pair = titles[name] || titles.threads;
    if (els.sidebarKicker) els.sidebarKicker.textContent = pair[0];
    if (els.sidebarTitle) els.sidebarTitle.textContent = pair[1];
    if (name === "pantry") refreshPantry().catch(() => {});
    if (name === "profile") refreshProfile().catch(() => {});
  }

  async function refreshPantry() {
    try {
      const res = await fetch(API.pantry);
      if (!res.ok) return;
      const data = await res.json();
      state.pantry = Array.isArray(data.items) ? data.items : [];
    } catch {
      // keep cache
    }
    renderPantry();
  }

  function renderPantry() {
    if (!els.pantryList) return;
    const items = state.pantry;
    if (els.pantryEmpty) els.pantryEmpty.hidden = items.length > 0;
    els.pantryList.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "pantry-item";
      const qty = item.quantity != null
        ? ` · ${Number.isInteger(item.quantity) ? item.quantity : item.quantity}${item.unit || ""}`
        : "";
      const freshness = item.freshness && item.freshness !== "未知" ? ` · ${item.freshness}` : "";
      li.innerHTML =
        `<div>` +
        `<span class="pantry-item-name">${escapeHtml(item.display_name || item.name)}</span>` +
        `<span class="pantry-item-meta">${escapeHtml((item.category || "其他") + qty + freshness)}</span>` +
        `</div>`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "thread-del";
      del.title = "从冰箱移除";
      del.setAttribute("aria-label", "从冰箱移除");
      del.innerHTML = iconSvg("trash");
      del.addEventListener("click", () => removePantryItem(item.name));
      li.appendChild(del);
      els.pantryList.appendChild(li);
    }
  }

  async function addPantryItem(event) {
    event.preventDefault();
    const name = (els.pantryNameInput?.value || "").trim();
    if (!name) return;
    const category = els.pantryCategorySelect?.value || "其他";
    try {
      const res = await fetch(API.pantry, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, category, source: "manual" }),
      });
      if (!res.ok) throw new Error("添加失败");
      if (els.pantryNameInput) els.pantryNameInput.value = "";
      await refreshPantry();
    } catch {
      // ignore
    }
  }

  async function removePantryItem(name) {
    if (!name) return;
    if (!window.confirm(`从冰箱移除「${name}」？`)) return;
    try {
      await fetch(API.pantryRemove, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: [name] }),
      });
    } catch {
      // ignore
    }
    await refreshPantry();
  }

  async function refreshProfile() {
    try {
      const res = await fetch(API.profile);
      if (!res.ok) return;
      const data = await res.json();
      fillProfileForm(data);
    } catch {
      // ignore
    }
  }

  function fillProfileForm(data) {
    const household = document.getElementById("profileHousehold");
    const taste = document.getElementById("profileTaste");
    const likes = document.getElementById("profileLikes");
    const dislikes = document.getElementById("profileDislikes");
    const allergies = document.getElementById("profileAllergies");
    const diet = document.getElementById("profileDiet");
    const appliances = document.getElementById("profileAppliances");
    const notes = document.getElementById("profileNotes");
    if (household) household.value = data.household_size || 1;
    if (taste) taste.value = joinTags(data.taste_pref);
    if (likes) likes.value = joinTags(data.likes);
    if (dislikes) dislikes.value = joinTags(data.dislikes);
    if (allergies) allergies.value = joinTags(data.allergies);
    if (diet) diet.value = joinTags(data.diet_tags);
    if (appliances) appliances.value = joinTags(data.appliances);
    if (notes) notes.value = data.notes || "";
  }

  async function saveProfile(event) {
    event.preventDefault();
    const body = {
      household_size: Number(document.getElementById("profileHousehold")?.value || 1),
      taste_pref: splitTags(document.getElementById("profileTaste")?.value),
      likes: splitTags(document.getElementById("profileLikes")?.value),
      dislikes: splitTags(document.getElementById("profileDislikes")?.value),
      allergies: splitTags(document.getElementById("profileAllergies")?.value),
      diet_tags: splitTags(document.getElementById("profileDiet")?.value),
      appliances: splitTags(document.getElementById("profileAppliances")?.value),
      notes: document.getElementById("profileNotes")?.value || "",
    };
    try {
      const res = await fetch(API.profile, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("保存失败");
      if (els.profileSaved) {
        els.profileSaved.hidden = false;
        window.setTimeout(() => {
          if (els.profileSaved) els.profileSaved.hidden = true;
        }, 1800);
      }
    } catch {
      // ignore
    }
  }

  function renderThreadList() {
    if (!els.threadNav) return;
    const list = state.threads;
    els.threadNav.innerHTML = "";
    if (els.threadEmpty) els.threadEmpty.hidden = list.length > 0;

    for (const item of list) {
      const row = document.createElement("div");
      row.className = `thread-item${item.id === state.threadId ? " active" : ""}`;
      row.dataset.threadId = item.id;

      const main = document.createElement("button");
      main.type = "button";
      main.className = "thread-main";
      main.title = "查看历史消息";
      main.innerHTML =
        `<span class="thread-title">${escapeHtml(item.title || "未命名会话")}</span>` +
        `<span class="thread-time">${escapeHtml(formatTime(item.updated_at))}</span>`;
      main.addEventListener("click", () => {
        if (row.classList.contains("is-renaming")) return;
        switchThread(item.id);
      });

      const actions = document.createElement("div");
      actions.className = "thread-actions";

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "thread-rename";
      renameBtn.title = "重命名";
      renameBtn.setAttribute("aria-label", "重命名会话");
      renameBtn.innerHTML = iconSvg("rename");
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startRename(item.id);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "thread-del";
      del.title = "删除会话";
      del.setAttribute("aria-label", "删除会话");
      del.innerHTML = iconSvg("trash");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        startDelete(item.id);
      });

      actions.appendChild(renameBtn);
      actions.appendChild(del);
      row.appendChild(main);
      row.appendChild(actions);
      els.threadNav.appendChild(row);
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    els.composer.classList.toggle("busy", busy);
    els.pickImageBtn.disabled = busy;
    syncActionButton();
  }

  function canSend() {
    return Boolean(els.messageInput.value.trim() || state.pendingFile);
  }

  function syncActionButton() {
    const btn = els.actionBtn;
    if (!btn) return;
    const ready = canSend();
    btn.disabled = false;
    btn.removeAttribute("disabled");
    if (state.busy) {
      btn.classList.remove("is-send", "is-idle");
      btn.classList.add("is-stop");
      btn.setAttribute("aria-label", "停止生成");
      btn.title = "停止生成";
      btn.setAttribute("aria-disabled", "false");
      if (els.actionSendIcon) els.actionSendIcon.hidden = true;
      if (els.actionStopIcon) els.actionStopIcon.hidden = false;
      if (els.sendLabel) els.sendLabel.textContent = "停止";
    } else {
      btn.classList.remove("is-stop");
      btn.classList.add("is-send");
      btn.classList.toggle("is-idle", !ready);
      btn.setAttribute("aria-label", ready ? "发送" : "请先输入内容");
      btn.title = ready ? "发送（Enter）" : "输入内容后即可发送";
      btn.setAttribute("aria-disabled", ready ? "false" : "true");
      if (els.actionSendIcon) els.actionSendIcon.hidden = false;
      if (els.actionStopIcon) els.actionStopIcon.hidden = true;
      if (els.sendLabel) els.sendLabel.textContent = "发送";
    }
  }

  function syncSendButton() {
    syncActionButton();
  }

  function showChat() {
    els.welcome.hidden = true;
    els.messages.hidden = false;
  }

  function showWelcome() {
    els.welcome.hidden = false;
    els.messages.hidden = true;
    els.messages.innerHTML = "";
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      els.stage.scrollTop = els.stage.scrollHeight;
    });
  }

  function escapeHtml(text) {
    return String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function proxyImageUrl(url) {
    if (!url) return "";
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    if (url.startsWith("/api/v1/proxy/image")) return url;
    // 本站 OSS 直链可直接用；外链走代理（若后端未部署代理则回退原链）
    if (/aliyuncs\.com|localhost|127\.0\.0\.1/.test(url)) return url;
    return `/api/v1/proxy/image?url=${encodeURIComponent(url)}`;
  }

  function renderMarkdown(text) {
    const raw = text || "";
    if (!window.marked) {
      return escapeHtml(raw).replaceAll("\n", "<br>");
    }

    const renderer = new marked.Renderer();
    renderer.image = function image(token) {
      let href;
      let title;
      let alt;
      if (typeof token === "object" && token) {
        href = token.href;
        title = token.title;
        alt = token.text;
      } else {
        href = token;
        title = arguments[1];
        alt = arguments[2];
      }
      if (!href) return "";
      const src = proxyImageUrl(href);
      const safeAlt = escapeHtml(alt || "参考图");
      const safeHref = escapeHtml(href);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return (
        `<figure class="md-image">` +
        `<img src="${escapeHtml(src)}" alt="${safeAlt}"${titleAttr} loading="lazy" referrerpolicy="no-referrer" ` +
        `onerror="this.style.display='none';this.nextElementSibling.hidden=false;" />` +
        `<a class="md-image-fallback" href="${safeHref}" target="_blank" rel="noopener noreferrer" hidden>打开参考图</a>` +
        `</figure>`
      );
    };

    return marked.parse(raw, { renderer, breaks: true, gfm: true });
  }

  function appendMessage({ role, text = "", imageUrl = null, error = false }) {
    showChat();
    const wrap = document.createElement("article");
    wrap.className = `msg ${role}${error ? " error" : ""}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "你" : error ? "!" : "厨";

    const body = document.createElement("div");
    body.className = "msg-body";

    if (imageUrl) {
      const img = document.createElement("img");
      img.className = "msg-image";
      img.src = imageUrl.startsWith("blob:") ? imageUrl : proxyImageUrl(imageUrl);
      img.alt = "上传的食材图片";
      img.referrerPolicy = "no-referrer";
      body.appendChild(img);
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "assistant" && !error) {
      bubble.innerHTML = renderMarkdown(text);
    } else {
      bubble.textContent = text;
    }
    body.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = role === "user" ? "你" : error ? "提示" : "私厨";
    body.appendChild(meta);

    wrap.appendChild(avatar);
    wrap.appendChild(body);
    els.messages.appendChild(wrap);
    scrollToBottom();
    return { wrap, bubble, meta };
  }

  function clearPendingImage() {
    if (state.pendingPreviewUrl) URL.revokeObjectURL(state.pendingPreviewUrl);
    state.pendingFile = null;
    state.pendingPreviewUrl = null;
    els.preview.hidden = true;
    els.previewImg.removeAttribute("src");
    els.fileInput.value = "";
    syncSendButton();
  }

  function setPendingImage(file) {
    clearPendingImage();
    state.pendingFile = file;
    state.pendingPreviewUrl = URL.createObjectURL(file);
    els.previewImg.src = state.pendingPreviewUrl;
    els.preview.hidden = false;
    syncSendButton();
  }

  async function uploadImage(file) {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const filename = `chief/${state.threadId}/${Date.now()}.${ext}`;
    const res = await fetch(`${API.presign}?filename=${encodeURIComponent(filename)}`);
    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(detail || `获取上传签名失败（${res.status}）`);
    }
    const data = await res.json();
    const put = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": data.contentType },
      body: file,
      signal: state.abortController?.signal,
    });
    if (!put.ok) throw new Error(`图片上传失败（${put.status}）`);
    return data.accessUrl;
  }

  async function safeText(res) {
    try {
      return (await res.text()).trim();
    } catch {
      return "";
    }
  }

  function extractStreamChunk(payload) {
    if (payload == null || payload === "") return "";
    if (typeof payload === "string") {
      const trimmed = payload.trim();
      if (!trimmed || trimmed === "null" || trimmed === "None") return "";
      try {
        return extractStreamChunk(JSON.parse(trimmed));
      } catch {
        return payload;
      }
    }
    if (typeof payload === "object") {
      if (typeof payload.content === "string") return payload.content;
      if (typeof payload.text === "string") return payload.text;
      if (typeof payload.delta === "string") return payload.delta;
      if (typeof payload.data === "string") return payload.data;
      if (payload.choices?.[0]?.delta?.content) return payload.choices[0].delta.content;
      if (typeof payload.message === "string") return payload.message;
    }
    return "";
  }

  async function consumeChatStream(response, onDelta) {
    const contentType = response.headers.get("content-type") || "";
    if (!response.body || contentType.includes("application/json")) {
      const raw = await response.text();
      if (!raw || raw.trim() === "null") return { empty: true, text: "" };
      const chunk = extractStreamChunk(raw);
      if (chunk) onDelta(chunk);
      return { empty: !chunk, text: chunk };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    const isSse = contentType.includes("text/event-stream");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      if (isSse) {
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const chunk = extractStreamChunk(data);
          if (chunk) {
            full += chunk;
            onDelta(chunk);
          }
        }
      } else {
        full += buffer;
        onDelta(buffer);
        buffer = "";
      }
    }

    if (buffer.trim()) {
      let leftover = buffer.trim();
      if (isSse && leftover.startsWith("data:")) leftover = leftover.slice(5).trim();
      const chunk = extractStreamChunk(leftover);
      if (chunk) {
        full += chunk;
        onDelta(chunk);
      }
    }

    return { empty: !full.trim(), text: full };
  }

  function stopGeneration() {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
  }

  function openSidebar() {
    if (!els.shell || !els.sidebarBackdrop) return;
    els.shell.classList.add("sidebar-open");
    els.sidebarBackdrop.hidden = false;
  }

  function closeSidebar() {
    if (els.shell) els.shell.classList.remove("sidebar-open");
    if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
  }

  async function sendMessage(rawText) {
    if (state.busy) return;
    const text = (rawText ?? els.messageInput.value).trim();
    const file = state.pendingFile;
    if (!text && !file) return;

    state.abortController = new AbortController();
    setBusy(true);
    let imageUrl = null;
    const localPreview = state.pendingPreviewUrl;
    const userText = text || "请根据这张食材图片推荐菜谱";

    try {
      if (file) imageUrl = await uploadImage(file);

      appendMessage({
        role: "user",
        text: userText,
        imageUrl: localPreview || imageUrl,
      });

      upsertLocalThread(state.threadId, { title: userText });
      localStorage.setItem(STORAGE_KEY, state.threadId);
      updateHeader();
      renderThreadList();

      els.messageInput.value = "";
      autosize();
      clearPendingImage();

      const assistant = appendMessage({ role: "assistant", text: "" });
      assistant.bubble.classList.add("streaming");
      assistant.bubble.textContent = "";

      const res = await fetch(API.stream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          image_url: imageUrl,
          thread_id: state.threadId,
        }),
        signal: state.abortController.signal,
      });

      if (!res.ok) {
        const detail = await safeText(res);
        throw new Error(detail || `对话失败（${res.status}）`);
      }

      let assembled = "";
      const result = await consumeChatStream(res, (delta) => {
        assembled += delta;
        assistant.bubble.classList.remove("streaming");
        assistant.bubble.innerHTML = renderMarkdown(assembled);
        scrollToBottom();
      });

      assistant.bubble.classList.remove("streaming");

      if (result.empty && !assembled.trim()) {
        assistant.wrap.classList.add("error");
        assistant.bubble.textContent = "没有收到回复，请重试。";
        assistant.meta.textContent = "提示";
      } else {
        const fullText = assembled || result.text;
        assistant.bubble.innerHTML = renderMarkdown(fullText);
        applyAutoTitle(state.threadId, userText, fullText);
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        appendMessage({
          role: "assistant",
          text: "已停止生成。你可以继续提问。",
          error: true,
        });
      } else {
        appendMessage({
          role: "assistant",
          text: err.message || "发送失败，请稍后重试",
          error: true,
        });
      }
    } finally {
      state.abortController = null;
      setBusy(false);
      syncSendButton();
      els.messageInput.focus();
      refreshThreads().catch(() => {});
      refreshPantry().catch(() => {});
      refreshProfile().catch(() => {});
    }
  }

  async function loadRemoteHistory(threadId) {
    const res = await fetch(`${API.messages}?thread_id=${encodeURIComponent(threadId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.messages) ? data.messages : [];
  }

  async function renderHistory(threadId) {
    els.messages.innerHTML = "";
    const messages = await loadRemoteHistory(threadId);
    if (!messages.length) {
      showWelcome();
      return;
    }
    showChat();
    for (const msg of messages) {
      appendMessage({
        role: msg.role === "user" ? "user" : "assistant",
        text: typeof msg.content === "string" ? msg.content : "",
        imageUrl: msg.image_url || null,
      });
    }
  }

  async function switchThread(threadId) {
    if (threadId === state.threadId) {
      closeSidebar();
      return;
    }
    if (state.busy) stopGeneration();
    state.threadId = threadId;
    localStorage.setItem(STORAGE_KEY, threadId);
    updateHeader();
    renderThreadList();
    clearPendingImage();
    els.messageInput.value = "";
    autosize();
    closeSidebar();
    await renderHistory(threadId);
    syncSendButton();
  }

  async function newChat() {
    if (state.busy) stopGeneration();
    state.threadId = createThreadId();
    localStorage.setItem(STORAGE_KEY, state.threadId);
    updateHeader();
    renderThreadList();
    clearPendingImage();
    els.messageInput.value = "";
    autosize();
    showWelcome();
    closeSidebar();
    syncSendButton();
    els.messageInput.focus();
  }

  async function deleteThread(threadId) {
    try {
      await fetch(`${API.threads}/${encodeURIComponent(threadId)}`, {
        method: "DELETE",
      });
    } catch {
      // ignore
    }
    state.threads = state.threads.filter((t) => t.id !== threadId);
    if (threadId === state.threadId) {
      await newChat();
    }
    await refreshThreads();
  }

  function autosize() {
    const el = els.messageInput;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function isImeComposing(e) {
    return Boolean(e.isComposing || e.keyCode === 229);
  }

  els.messageInput.addEventListener("input", () => {
    autosize();
    syncSendButton();
  });

  els.messageInput.addEventListener("compositionend", () => {
    autosize();
    syncSendButton();
  });

  els.messageInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || isImeComposing(e)) return;
    e.preventDefault();
    if (state.busy) return;
    if (canSend()) sendMessage();
  });

  els.actionBtn?.addEventListener("click", () => {
    if (state.busy) {
      stopGeneration();
      return;
    }
    if (!canSend()) {
      els.messageInput.focus();
      els.composer?.classList.add("nudge");
      window.setTimeout(() => els.composer?.classList.remove("nudge"), 280);
      return;
    }
    sendMessage();
  });
  if (els.chatTitle) {
    els.chatTitle.style.cursor = "pointer";
    els.chatTitle.addEventListener("click", () => {
      const meta = currentMeta();
      if (!meta) return;
      const next = window.prompt("重命名当前会话", meta.title || "新对话");
      if (next && next.trim()) renameThread(state.threadId, next.trim());
    });
  }
  els.pickImageBtn.addEventListener("click", () => els.fileInput.click());
  els.removeImageBtn.addEventListener("click", clearPendingImage);
  els.sidebarNewChatBtn?.addEventListener("click", newChat);
  els.menuBtn?.addEventListener("click", openSidebar);
  els.sidebarBackdrop?.addEventListener("click", closeSidebar);
  els.pantryAddForm?.addEventListener("submit", addPantryItem);
  els.profileForm?.addEventListener("submit", saveProfile);
  document.querySelectorAll(".sidebar-tab").forEach((btn) => {
    btn.addEventListener("click", () => setSidebarPanel(btn.dataset.panel || "threads"));
  });

  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    if (file) setPendingImage(file);
  });

  document.querySelectorAll(".hint").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prompt = btn.getAttribute("data-prompt") || "";
      els.messageInput.value = prompt;
      autosize();
      syncSendButton();
      els.messageInput.focus();
    });
  });

  ["dragenter", "dragover"].forEach((type) => {
    els.composer.addEventListener(type, (e) => {
      e.preventDefault();
      els.composer.style.outline = "2px solid var(--accent)";
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    els.composer.addEventListener(type, (e) => {
      e.preventDefault();
      els.composer.style.outline = "";
    });
  });
  els.composer.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) setPendingImage(file);
  });

  syncSendButton();
  autosize();

  async function boot() {
    try {
      state.threads = await fetchThreads();
    } catch {
      state.threads = [];
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    const known = state.threads.find((t) => t.id === saved);
    if (known) {
      state.threadId = known.id;
      await renderHistory(state.threadId);
    } else {
      state.threadId = createThreadId();
      showWelcome();
    }
    localStorage.setItem(STORAGE_KEY, state.threadId);
    updateHeader();
    renderThreadList();
    refreshPantry().catch(() => {});
    refreshProfile().catch(() => {});
    syncSendButton();
  }

  boot().catch(() => {
    showWelcome();
    renderThreadList();
  });
})();
