(() => {
  const API = {
    presign: "/api/v1/oss/presign",
    stream: "/api/v1/chat/stream",
    messages: "/api/v1/chat/messages",
  };

  const STORAGE_KEY = "personal-chief-thread";
  const THREADS_KEY = "personal-chief-threads";

  const els = {
    shell: document.querySelector(".shell"),
    sidebar: document.getElementById("sidebar"),
    sidebarBackdrop: document.getElementById("sidebarBackdrop"),
    menuBtn: document.getElementById("menuBtn"),
    stage: document.getElementById("stage"),
    welcome: document.getElementById("welcome"),
    messages: document.getElementById("messages"),
    messageInput: document.getElementById("messageInput"),
    sendBtn: document.getElementById("actionBtn"),
    actionBtn: document.getElementById("actionBtn"),
    actionSendIcon: document.querySelector("#actionBtn .icon-send"),
    actionStopIcon: document.querySelector("#actionBtn .icon-stop"),
    pickImageBtn: document.getElementById("pickImageBtn"),
    fileInput: document.getElementById("fileInput"),
    preview: document.getElementById("preview"),
    previewImg: document.getElementById("previewImg"),
    removeImageBtn: document.getElementById("removeImageBtn"),
    newChatBtn: document.getElementById("newChatBtn"),
    clearBtn: document.getElementById("clearBtn"),
    threadNav: document.getElementById("threadNav"),
    threadEmpty: document.getElementById("threadEmpty"),
    threadLabel: document.getElementById("threadLabel"),
    chatTitle: document.getElementById("chatTitle"),
    composer: document.getElementById("composer"),
  };

  const state = {
    threadId: localStorage.getItem(STORAGE_KEY) || createThreadId(),
    pendingFile: null,
    pendingPreviewUrl: null,
    busy: false,
    abortController: null,
  };

  localStorage.setItem(STORAGE_KEY, state.threadId);
  touchThread(state.threadId);
  updateHeader();
  renderThreadList();

  if (window.marked) {
    marked.setOptions({ breaks: true, gfm: true });
  }

  function createThreadId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function loadThreads() {
    try {
      const raw = JSON.parse(localStorage.getItem(THREADS_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function saveThreads(list) {
    localStorage.setItem(THREADS_KEY, JSON.stringify(list.slice(0, 50)));
  }

  function touchThread(threadId, opts = {}) {
    const list = loadThreads();
    const idx = list.findIndex((t) => t.id === threadId);
    const title = typeof opts.title === "string" ? opts.title.trim().slice(0, 32) : "";
    const manual = Boolean(opts.manual);
    const forceAuto = Boolean(opts.forceAuto);

    if (idx >= 0) {
      list[idx].updatedAt = Date.now();
      if (manual && title) {
        list[idx].title = title;
        list[idx].manualTitle = true;
      } else if (forceAuto && title && !list[idx].manualTitle) {
        list[idx].title = title;
        list[idx].manualTitle = false;
      } else if (title && !list[idx].manualTitle && !list[idx].autoTitled) {
        // 首条用户消息先给临时标题，回复后再总结覆盖
        list[idx].title = title;
      }
    } else {
      list.unshift({
        id: threadId,
        title: title || "新对话",
        updatedAt: Date.now(),
        manualTitle: manual,
        autoTitled: false,
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    saveThreads(list);
  }

  function renameThread(threadId, title) {
    const next = (title || "").trim().slice(0, 32);
    if (!next) return;
    touchThread(threadId, { title: next, manual: true });
    updateHeader();
    renderThreadList();
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
    const list = loadThreads();
    const item = list.find((t) => t.id === threadId);
    // 手动改过名，或已自动总结过，则不再覆盖
    if (!item || item.manualTitle || item.autoTitled) return;
    const title = summarizeConversationTitle(userText, assistantText);
    item.title = title;
    item.autoTitled = true;
    item.updatedAt = Date.now();
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    saveThreads(list);
    updateHeader();
    renderThreadList();
  }

  function removeThreadMeta(threadId) {
    saveThreads(loadThreads().filter((t) => t.id !== threadId));
  }

  function currentMeta() {
    return loadThreads().find((t) => t.id === state.threadId);
  }

  function updateHeader() {
    const meta = currentMeta();
    const short = state.threadId.slice(0, 8);
    els.chatTitle.textContent = meta?.title || "新对话";
    els.chatTitle.title = "点击重命名当前会话";
    els.threadLabel.textContent = `会话 ${short}`;
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

  function startRename(threadId, titleSpan) {
    const meta = loadThreads().find((t) => t.id === threadId);
    if (!meta || !titleSpan) return;

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
      if (commit && val) renameThread(threadId, val);
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
    input.addEventListener("blur", () => finish(true));

    titleSpan.replaceWith(input);
    input.focus();
    input.select();
  }

  function renderThreadList() {
    const list = loadThreads();
    els.threadNav.innerHTML = "";
    els.threadEmpty.hidden = list.length > 0;

    for (const item of list) {
      const row = document.createElement("div");
      row.className = `thread-item${item.id === state.threadId ? " active" : ""}`;

      const main = document.createElement("button");
      main.type = "button";
      main.className = "thread-main";
      main.title = "单击切换 · 双击重命名";
      main.innerHTML =
        `<span class="thread-title">${escapeHtml(item.title || "未命名会话")}</span>` +
        `<span class="thread-time">${escapeHtml(formatTime(item.updatedAt))}</span>`;
      main.addEventListener("click", () => switchThread(item.id));
      main.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startRename(item.id, main.querySelector(".thread-title"));
      });

      const actions = document.createElement("div");
      actions.className = "thread-actions";

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "thread-rename";
      renameBtn.title = "重命名";
      renameBtn.setAttribute("aria-label", "重命名会话");
      renameBtn.textContent = "改";
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startRename(item.id, main.querySelector(".thread-title"));
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "thread-del";
      del.title = "删除会话";
      del.setAttribute("aria-label", "删除会话");
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteThread(item.id);
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
    if (state.busy) {
      btn.classList.remove("is-send");
      btn.classList.add("is-stop");
      btn.disabled = false;
      btn.setAttribute("aria-label", "取消发送");
      btn.title = "取消发送";
      els.actionSendIcon.hidden = true;
      els.actionStopIcon.hidden = false;
    } else {
      btn.classList.remove("is-stop");
      btn.classList.add("is-send");
      btn.disabled = !canSend();
      btn.setAttribute("aria-label", "发送");
      btn.title = "发送";
      els.actionSendIcon.hidden = false;
      els.actionStopIcon.hidden = true;
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
    els.shell.classList.add("sidebar-open");
    els.sidebarBackdrop.hidden = false;
  }

  function closeSidebar() {
    els.shell.classList.remove("sidebar-open");
    els.sidebarBackdrop.hidden = true;
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

      touchThread(state.threadId, { title: userText });
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
    touchThread(threadId);
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
    touchThread(state.threadId, { title: "新对话" });
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

  async function clearChat() {
    if (state.busy) stopGeneration();
    try {
      await fetch(`${API.messages}?thread_id=${encodeURIComponent(state.threadId)}`, {
        method: "DELETE",
      });
    } catch {
      // ignore
    }
    const list = loadThreads();
    const cur = list.find((t) => t.id === state.threadId);
    if (cur) {
      cur.title = "新对话";
      cur.manualTitle = false;
      cur.autoTitled = false;
      cur.updatedAt = Date.now();
      saveThreads(list);
    }
    clearPendingImage();
    els.messageInput.value = "";
    autosize();
    showWelcome();
    updateHeader();
    renderThreadList();
    syncSendButton();
  }

  async function deleteThread(threadId) {
    try {
      await fetch(`${API.messages}?thread_id=${encodeURIComponent(threadId)}`, {
        method: "DELETE",
      });
    } catch {
      // ignore
    }
    removeThreadMeta(threadId);
    if (threadId === state.threadId) {
      await newChat();
    } else {
      renderThreadList();
    }
  }

  function autosize() {
    const el = els.messageInput;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  els.messageInput.addEventListener("input", () => {
    autosize();
    syncSendButton();
  });

  els.messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!state.busy) sendMessage();
    }
  });

  els.actionBtn.addEventListener("click", () => {
    if (state.busy) stopGeneration();
    else sendMessage();
  });
  els.chatTitle.style.cursor = "pointer";
  els.chatTitle.addEventListener("click", () => {
    const meta = currentMeta();
    if (!meta) return;
    const next = window.prompt("重命名当前会话", meta.title || "新对话");
    if (next && next.trim()) renameThread(state.threadId, next.trim());
  });
  els.pickImageBtn.addEventListener("click", () => els.fileInput.click());
  els.removeImageBtn.addEventListener("click", clearPendingImage);
  els.newChatBtn.addEventListener("click", newChat);
  els.clearBtn.addEventListener("click", clearChat);
  els.menuBtn.addEventListener("click", openSidebar);
  els.sidebarBackdrop.addEventListener("click", closeSidebar);

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
  renderHistory(state.threadId).catch(() => showWelcome());
})();
