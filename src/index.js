/**
 * HPL的专用云 (Cloudflare Workers + R2 单文件完整版)
 * 零外部依赖，服务端认证驱动，带取消传输防卡死、实时速率进度、搜索与操作弹窗
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 获取密码（默认 admin123456，自动过滤首尾引号及空格）
    const getPassword = () => {
      const p = env.AUTH_PASSWORD || "admin123456";
      return String(p).replace(/^["']|["']$/g, "").trim() || "admin123456";
    };

    // 检查是否已通过密码认证
    const isAuthed = () => {
      const correct = getPassword();

      // 1. Authorization: Bearer <password>
      const auth = request.headers.get("Authorization");
      if (auth && auth.startsWith("Bearer ") && auth.substring(7) === correct) {
        return true;
      }

      // 2. Cookie cf_auth=<password>
      const cookie = request.headers.get("Cookie");
      if (cookie) {
        const matches = cookie.match(/(?:^|;\s*)cf_auth=([^;]+)/);
        if (matches && decodeURIComponent(matches[1]) === correct) {
          return true;
        }
      }

      // 3. Query string ?auth=<password>
      const q = url.searchParams.get("auth");
      if (q && q === correct) {
        return true;
      }

      return false;
    };

    // ================= 路由 1: 密码验证 (POST /api/auth) =================
    if (path === "/api/auth") {
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const correct = getPassword();
          if (body.password === correct) {
            return new Response(JSON.stringify({ success: true }), {
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Set-Cookie": "cf_auth=" + encodeURIComponent(body.password) + "; Path=/; Max-Age=2592000; SameSite=Lax",
              },
            });
          } else {
            return new Response(JSON.stringify({ success: false, error: "密码错误，请重新输入！" }), {
              status: 401,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } catch (e) {
          return new Response(JSON.stringify({ error: "请求格式错误" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // ================= 路由 2: 网页渲染 (GET /) =================
    if (!path.startsWith("/api/")) {
      const authed = isAuthed();
      return new Response(renderHTML(authed), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 接口拦截：未登录禁止访问 /api/*
    if (!isAuthed()) {
      return new Response(JSON.stringify({ error: "未授权或登录已过期" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 检查 R2 绑定
    if (!env.BUCKET) {
      return new Response(
        JSON.stringify({ 
          error: "Cloudflare R2 存储桶未绑定！请在控制台该 Worker 的【设置】->【变量与机密】->【R2 存储桶绑定】中，添加变量名为 BUCKET（大写）并绑定您的 R2 存储桶。" 
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ================= 路由 3: 文件列表 (GET /api/list) =================
    if (path === "/api/list") {
      try {
        const prefix = url.searchParams.get("prefix") || "";
        const limit = parseInt(url.searchParams.get("limit") || "1000", 10);
        const listed = await env.BUCKET.list({ prefix, limit });

        let totalSize = 0;
        const files = listed.objects.map((obj) => {
          totalSize += obj.size;
          return {
            key: obj.key,
            size: obj.size,
            uploaded: obj.uploaded,
          };
        });

        files.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

        return new Response(
          JSON.stringify({ files, totalCount: files.length, totalSize }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: "获取列表失败: " + err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ================= 路由 4: 文件上传 (PUT /api/upload?name=...) =================
    if (path === "/api/upload") {
      try {
        let key = url.searchParams.get("name");
        if (!key) {
          return new Response(JSON.stringify({ error: "缺少文件名参数" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        key = decodeURIComponent(key);
        const contentType = request.headers.get("Content-Type") || "application/octet-stream";

        await env.BUCKET.put(key, request.body, {
          httpMetadata: { contentType },
        });

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "上传失败: " + err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ================= 路由 5: 文件下载与删除 (/api/file/<name>) =================
    if (path.startsWith("/api/file/")) {
      const rawKey = path.substring("/api/file/".length);
      const key = decodeURIComponent(rawKey);

      // 下载
      if (request.method === "GET") {
        try {
          const object = await env.BUCKET.get(key);
          if (!object) {
            return new Response("文件不存在", { status: 404 });
          }

          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set("etag", object.httpEtag);
          headers.set("Access-Control-Allow-Origin", "*");
          headers.set("Content-Length", object.size.toString());

          const filename = key.split("/").pop() || "download";
          const encoded = encodeURIComponent(filename);
          headers.set("Content-Disposition", "attachment; filename=\"" + encoded + "\"; filename*=UTF-8''" + encoded);

          return new Response(object.body, { headers });
        } catch (err) {
          return new Response("下载失败: " + err.message, { status: 500 });
        }
      }

      // 删除
      if (request.method === "DELETE") {
        try {
          await env.BUCKET.delete(key);
          return new Response(JSON.stringify({ success: true, key }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: "删除失败: " + err.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

function renderHTML(isAuthed) {
  let content = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>HPL的专用云</title>
  <style>
    :root {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --radius: 12px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --card-bg: #1e293b;
        --text: #f8fafc;
        --text-muted: #94a3b8;
        --border: #334155;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body { background-color: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }

    /* 登录界面样式 */
    .login-container {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .login-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 38px 28px;
      width: 100%;
      max-width: 360px;
      text-align: center;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1);
    }
    .login-icon { font-size: 42px; margin-bottom: 12px; }
    .login-title { font-size: 1.35rem; font-weight: 700; margin-bottom: 6px; }
    .login-sub { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 22px; }
    .login-input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 1rem;
      outline: none;
      margin-bottom: 16px;
    }
    .login-input:focus { border-color: var(--primary); }
    .login-btn {
      width: 100%;
      padding: 12px;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    .login-btn:hover { background: var(--primary-hover); }

    /* 工作台样式 */
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 14px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand { font-size: 1.15rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .header-actions { display: flex; gap: 10px; align-items: center; }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      user-select: none;
    }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-outline { background: transparent; border-color: var(--border); color: var(--text); }
    .btn-danger { background: rgba(239, 68, 68, 0.15); color: var(--danger); }
    .btn-danger:hover { background: var(--danger); color: white; }
    .btn-sm { padding: 5px 10px; font-size: 0.8rem; }

    main {
      max-width: 1100px;
      width: 100%;
      margin: 0 auto;
      padding: 24px 16px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      flex: 1;
    }

    .stats-row { display: flex; gap: 12px; }
    .stat-card {
      flex: 1;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 20px;
    }
    .stat-card .label { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px; }
    .stat-card .val { font-size: 1.3rem; font-weight: 700; }

    .upload-zone {
      background: var(--card-bg);
      border: 2px dashed var(--border);
      border-radius: var(--radius);
      padding: 32px 16px;
      text-align: center;
      cursor: pointer;
      display: block;
      transition: border-color 0.2s, background-color 0.2s;
    }
    .upload-zone:hover { border-color: var(--primary); background: rgba(37, 99, 235, 0.03); }

    .hidden-input {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0,0,0,0);
      border: 0;
      opacity: 0;
    }

    .toolbar-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .search-box { flex: 1; max-width: 320px; }
    .search-input {
      width: 100%;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--card-bg);
      color: var(--text);
      font-size: 0.875rem;
      outline: none;
    }
    .search-input:focus { border-color: var(--primary); }

    .file-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem; }
    th { padding: 12px 16px; background: rgba(0,0,0,0.02); color: var(--text-muted); border-bottom: 1px solid var(--border); }
    td { padding: 12px 16px; border-bottom: 1px solid var(--border); }
    tr:last-child td { border-bottom: none; }
    .file-actions { display: flex; gap: 8px; justify-content: flex-end; }

    /* 传输进度弹窗 (居中悬浮、带取消防卡死按钮) */
    .modal-mask {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 20px;
    }
    .modal-box {
      background: var(--card-bg);
      border-radius: var(--radius);
      width: 100%;
      max-width: 420px;
      padding: 24px;
      box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2);
    }
    .bar-bg { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; margin: 14px 0 10px; }
    .bar-fill { height: 100%; width: 0%; background: var(--primary); transition: width 0.15s; }
  </style>
</head>
<body>
`;

  if (!isAuthed) {
    content += `
  <div class="login-container">
    <div class="login-card">
      <div class="login-icon">☁️</div>
      <div class="login-title">HPL的专用云</div>
      <div class="login-sub">请输入访问密码以解锁进入</div>
      <input type="password" id="loginPass" class="login-input" placeholder="输入访问密码..." autofocus onkeydown="if(event.key==='Enter') doLogin()">
      <button class="login-btn" id="loginBtn" onclick="doLogin()">进入云盘</button>
    </div>
  </div>

  <script>
    async function doLogin() {
      const input = document.getElementById("loginPass");
      const pass = input.value.trim();
      if (!pass) {
        alert("请输入访问密码！");
        input.focus();
        return;
      }

      const btn = document.getElementById("loginBtn");
      btn.textContent = "正在验证...";
      btn.disabled = true;

      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pass }),
        });
        const data = await res.json().catch(function() { return {}; });

        if (res.status === 200 && data.success) {
          document.cookie = "cf_auth=" + encodeURIComponent(pass) + "; path=/; max-age=2592000; SameSite=Lax";
          window.location.reload();
        } else {
          alert(data.error || "密码错误，请重新输入！");
          input.value = "";
          input.focus();
        }
      } catch (e) {
        alert("网络连接异常，请检查 Worker 部署状态！");
      } finally {
        btn.textContent = "进入云盘";
        btn.disabled = false;
      }
    }
  </script>
`;
  } else {
    content += `
  <header>
    <div class="brand">☁️ HPL的专用云</div>
    <div class="header-actions">
      <input type="file" id="filePicker" multiple class="hidden-input">
      <label for="filePicker" class="btn btn-primary">⬆️ 上传文件</label>
      <button class="btn btn-outline btn-sm" onclick="fetchList()">🔄 刷新自检</button>
      <button class="btn btn-outline btn-sm" onclick="doLogout()">退出登录</button>
    </div>
  </header>

  <main>
    <div class="stats-row">
      <div class="stat-card">
        <div class="label">文件总数</div>
        <div class="val" id="countVal">0 个</div>
      </div>
      <div class="stat-card">
        <div class="label">已用存储</div>
        <div class="val" id="sizeVal">0 B</div>
      </div>
    </div>

    <label for="filePicker" class="upload-zone" id="dropArea">
      <div style="font-size: 36px; margin-bottom: 8px;">📂</div>
      <div style="font-weight: 600; font-size: 1.05rem;">点击或拖拽文件到这里上传</div>
      <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 4px;">支持电脑批量拖拽、手机相册与文件直接选择</div>
    </label>

    <div class="toolbar-row">
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="🔍 搜索文件名..." class="search-input" oninput="filterFiles()">
      </div>
      <div style="font-size: 0.8rem; color: var(--text-muted);">
        R2 实时云存储
      </div>
    </div>

    <div class="file-card">
      <table>
        <thead>
          <tr>
            <th>文件名</th>
            <th>大小</th>
            <th style="text-align: right;">操作</th>
          </tr>
        </thead>
        <tbody id="listBody"></tbody>
      </table>
      <div id="emptyNotice" style="padding: 40px; text-align: center; color: var(--text-muted); display: none;">
        云盘暂无文件，点击上方区域开始上传吧
      </div>
    </div>
  </main>

  <!-- 传输进度弹窗 (带取消防卡死按钮) -->
  <div class="modal-mask" id="progressModal">
    <div class="modal-box">
      <div style="display: flex; justify-content: space-between; font-weight: 600;">
        <span id="pTitle">正在传输...</span>
        <span id="pPercent">0%</span>
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" id="pFileName">filename</div>
      <div class="bar-bg"><div class="bar-fill" id="pBar"></div></div>
      <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted);">
        <span id="pSpeed">0 KB/s</span>
        <span id="pSize">0 B / 0 B</span>
      </div>
      <div style="margin-top: 18px; text-align: right;">
        <button class="btn btn-danger btn-sm" onclick="cancelCurrentTransfer()">取消传输</button>
      </div>
    </div>
  </div>

  <script>
    let allFiles = [];
    let currentXHR = null;
    let isCanceled = false;

    // 立即执行初始化
    function init() {
      setupUploader();
      fetchList();
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }

    function doLogout() {
      document.cookie = "cf_auth=; path=/; max-age=0";
      window.location.reload();
    }

    // 取消传输防卡死
    function cancelCurrentTransfer() {
      isCanceled = true;
      if (currentXHR) {
        try { currentXHR.abort(); } catch(e) {}
        currentXHR = null;
      }
      hideProgress();
      alert("已取消当前传输任务！");
      fetchList();
    }

    // 文件检查与列表拉取
    async function fetchList() {
      try {
        const res = await fetch("/api/list", { credentials: "same-origin" });
        if (res.status === 401) {
          doLogout();
          return;
        }

        const data = await res.json().catch(function() { return {}; });

        if (res.status === 500) {
          if (data.error && data.error.includes("R2")) {
            alert("【存储桶提示】" + data.error);
          } else {
            alert("【获取列表失败】" + (data.error || "服务器错误"));
          }
          document.getElementById("countVal").textContent = "未就绪";
          document.getElementById("sizeVal").textContent = "未绑定";
          return;
        }

        allFiles = data.files || [];
        renderTable(allFiles);
        document.getElementById("countVal").textContent = (data.totalCount || 0) + " 个";
        document.getElementById("sizeVal").textContent = formatSize(data.totalSize || 0);
      } catch (e) {
        alert("【网络异常】无法连接到 Worker 服务，请检查网络！");
        document.getElementById("countVal").textContent = "网络异常";
        document.getElementById("sizeVal").textContent = "读取失败";
      }
    }

    function filterFiles() {
      const q = document.getElementById("searchInput").value.trim().toLowerCase();
      if (!q) {
        renderTable(allFiles);
        return;
      }
      const filtered = allFiles.filter(function(f) {
        return f.key.toLowerCase().includes(q);
      });
      renderTable(filtered);
    }

    function renderTable(files) {
      const tbody = document.getElementById("listBody");
      const empty = document.getElementById("emptyNotice");
      tbody.innerHTML = "";

      if (files.length === 0) {
        empty.style.display = "block";
        return;
      }
      empty.style.display = "none";

      files.forEach(function(f) {
        const tr = document.createElement("tr");

        const tdName = document.createElement("td");
        tdName.innerHTML = "<span style='margin-right: 6px;'>📄</span>" + escapeHtml(f.key);

        const tdSize = document.createElement("td");
        tdSize.style.color = "var(--text-muted)";
        tdSize.textContent = formatSize(f.size);

        const tdAct = document.createElement("td");
        const actDiv = document.createElement("div");
        actDiv.className = "file-actions";

        const btnDl = document.createElement("button");
        btnDl.className = "btn btn-outline btn-sm";
        btnDl.textContent = "下载";
        btnDl.onclick = function() { doDownload(f.key); };

        const btnDel = document.createElement("button");
        btnDel.className = "btn btn-danger btn-sm";
        btnDel.textContent = "删除";
        btnDel.onclick = function() { doDelete(f.key); };

        actDiv.appendChild(btnDl);
        actDiv.appendChild(btnDel);
        tdAct.appendChild(actDiv);

        tr.appendChild(tdName);
        tr.appendChild(tdSize);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });
    }

    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function formatSize(b) {
      if (b === 0) return "0 B";
      const k = 1024;
      const s = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(b) / Math.log(k));
      return (b / Math.pow(k, i)).toFixed(2) + " " + s[i];
    }

    function formatSpeed(bps) {
      if (!bps || bps <= 0) return "0 KB/s";
      if (bps < 1024) return bps.toFixed(0) + " B/s";
      const k = 1024;
      const s = ["KB/s", "MB/s", "GB/s"];
      const i = Math.floor(Math.log(bps) / Math.log(k)) - 1;
      return (bps / Math.pow(k, i + 1)).toFixed(1) + " " + (s[i] || "MB/s");
    }

    // 下载流程 (带进度与取消功能)
    function doDownload(key) {
      isCanceled = false;
      showProgress("📥 正在下载文件", key);
      const xhr = new XMLHttpRequest();
      currentXHR = xhr;
      xhr.open("GET", "/api/file/" + encodeURIComponent(key));
      xhr.responseType = "blob";
      xhr.withCredentials = true;

      let lastTime = Date.now();
      let lastLoaded = 0;

      xhr.onprogress = function(e) {
        if (isCanceled) return;
        const now = Date.now();
        const diff = (now - lastTime) / 1000;
        if (e.lengthComputable && e.total > 0) {
          const p = Math.round((e.loaded / e.total) * 100);
          updateProgress(p, formatSize(e.loaded) + " / " + formatSize(e.total));
          if (diff >= 0.3) {
            document.getElementById("pSpeed").textContent = formatSpeed((e.loaded - lastLoaded) / diff);
            lastTime = now;
            lastLoaded = e.loaded;
          }
        }
      };

      xhr.onload = function() {
        currentXHR = null;
        if (isCanceled) return;
        if (xhr.status === 200) {
          updateProgress(100, "下载完成");
          const blobUrl = window.URL.createObjectURL(xhr.response);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = key.split("/").pop() || "download";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function() {
            window.URL.revokeObjectURL(blobUrl);
            hideProgress();
          }, 800);
        } else {
          hideProgress();
          alert("【下载失败】服务器返回状态码: " + xhr.status);
        }
      };

      xhr.onabort = function() {
        currentXHR = null;
      };

      xhr.onerror = function() {
        currentXHR = null;
        if (isCanceled) return;
        hideProgress();
        alert("【下载失败】网络连接中断，请重试！");
      };

      xhr.send();
    }

    // 删除流程
    async function doDelete(key) {
      if (!confirm("确定要删除文件 " + key + " 吗？")) return;

      try {
        const res = await fetch("/api/file/" + encodeURIComponent(key), { method: "DELETE", credentials: "same-origin" });
        const data = await res.json().catch(function() { return {}; });
        if (data.success) {
          fetchList();
        } else {
          alert("【删除失败】" + (data.error || "未知原因"));
        }
      } catch (e) {
        alert("【删除失败】网络请求发生异常！");
      }
    }

    // 上传与拖拽绑定
    function setupUploader() {
      const picker = document.getElementById("filePicker");
      const drop = document.getElementById("dropArea");

      picker.addEventListener("change", function(e) {
        if (e.target.files && e.target.files.length > 0) {
          handleUploads(Array.from(e.target.files));
          picker.value = "";
        }
      });

      ["dragenter", "dragover"].forEach(function(ev) {
        drop.addEventListener(ev, function(e) { e.preventDefault(); });
      });
      drop.addEventListener("drop", function(e) {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleUploads(Array.from(e.dataTransfer.files));
        }
      });
    }

    // 多文件队列上传 (带取消与失败弹窗)
    async function handleUploads(files) {
      isCanceled = false;
      for (let i = 0; i < files.length; i++) {
        if (isCanceled) break;
        const file = files[i];
        showProgress("⬆️ 正在上传 (" + (i + 1) + "/" + files.length + ")", file.name);

        let lastTime = Date.now();
        let lastLoaded = 0;

        await new Promise(function(resolve) {
          const xhr = new XMLHttpRequest();
          currentXHR = xhr;
          xhr.open("PUT", "/api/upload?name=" + encodeURIComponent(file.name));
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.withCredentials = true;

          xhr.upload.onprogress = function(e) {
            if (isCanceled) return;
            const now = Date.now();
            const diff = (now - lastTime) / 1000;
            if (e.lengthComputable && e.total > 0) {
              const p = Math.round((e.loaded / e.total) * 100);
              updateProgress(p, formatSize(e.loaded) + " / " + formatSize(e.total));
              if (diff >= 0.3) {
                document.getElementById("pSpeed").textContent = formatSpeed((e.loaded - lastLoaded) / diff);
                lastTime = now;
                lastLoaded = e.loaded;
              }
            }
          };

          xhr.onload = function() {
            currentXHR = null;
            if (isCanceled) { resolve(); return; }
            let resData = {};
            try { resData = JSON.parse(xhr.responseText); } catch(err) {}
            if (xhr.status === 200) {
              updateProgress(100, "上传完成");
              setTimeout(function() { resolve(); }, 400);
            } else {
              hideProgress();
              alert("【上传失败】" + file.name + ": " + (resData.error || "状态码 " + xhr.status));
              resolve();
            }
          };

          xhr.onabort = function() {
            currentXHR = null;
            resolve();
          };

          xhr.onerror = function() {
            currentXHR = null;
            if (isCanceled) { resolve(); return; }
            hideProgress();
            alert("【上传失败】" + file.name + ": 网络传输发生错误或已中断！");
            resolve();
          };

          xhr.send(file);
        });
      }

      currentXHR = null;
      hideProgress();
      fetchList();
    }

    function showProgress(title, filename) {
      document.getElementById("pTitle").textContent = title;
      document.getElementById("pFileName").textContent = filename;
      document.getElementById("pPercent").textContent = "0%";
      document.getElementById("pBar").style.width = "0%";
      document.getElementById("pSpeed").textContent = "0 KB/s";
      document.getElementById("pSize").textContent = "准备中...";
      document.getElementById("progressModal").style.display = "flex";
    }

    function updateProgress(percent, sizeText) {
      document.getElementById("pPercent").textContent = percent + "%";
      document.getElementById("pBar").style.width = percent + "%";
      document.getElementById("pSize").textContent = sizeText;
    }

    function hideProgress() {
      document.getElementById("progressModal").style.display = "none";
    }
  </script>
`;
  }

  content += `
</body>
</html>`;
  return content;
}
