const state = { events: [], alerts: [], stats: {}, charts: {} };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const localDate = (value, options = {}) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, options).format(date);
};
const relativeTime = (value) => {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (!Number.isFinite(diff)) return "—";
  if (diff < 1) return "Just now";
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
};
const riskClass = (level) => `risk-${String(level || "low").toLowerCase()}`;
const riskBadge = (level, score) => `<span class="risk-pill ${riskClass(level)}">${escapeHtml(level)}${score !== undefined ? ` · ${escapeHtml(score)}` : ""}</span>`;
const statusBadge = (status) => `<span class="status-pill ${status === "Success" ? "status-success" : "status-failed"}">${escapeHtml(status)}</span>`;
const initials = (username) => String(username || "?").split(/[._\s-]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  item.innerHTML = `<i data-lucide="${error ? "circle-alert" : "circle-check"}"></i><span>${escapeHtml(message)}</span>`;
  $("#toast-region").append(item);
  if (window.lucide) lucide.createIcons({ nodes: [item] });
  window.setTimeout(() => item.remove(), 3600);
}

function navigate(page) {
  if (!document.getElementById(`page-${page}`)) page = "dashboard";
  $$(".page").forEach((section) => section.classList.toggle("active", section.id === `page-${page}`));
  $$(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === page));
  const active = $(`.nav-link[data-page="${page}"]`);
  $("#breadcrumb-current").textContent = active?.querySelector("span")?.textContent || "Overview";
  history.replaceState(null, "", `#${page}`);
  $("#sidebar").classList.remove("open");
  if (page === "reports" || page === "dashboard") requestAnimationFrame(() => resizeCharts());
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function getDailySeries(events) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    return date;
  });
  const labels = days.map((date) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date));
  const successful = days.map(() => 0);
  const failed = days.map(() => 0);
  const failedAttempts = days.map(() => 0);
  for (const event of events) {
    const date = new Date(event.login_time);
    if (Number.isNaN(date.getTime())) continue;
    date.setHours(0, 0, 0, 0);
    const index = days.findIndex((day) => day.getTime() === date.getTime());
    if (index < 0) continue;
    if (event.status === "Success") successful[index]++;
    else {
      failed[index]++;
      failedAttempts[index] += Math.max(1, Number(event.failed_attempts) || 1);
    }
  }
  return { labels, successful, failed, failedAttempts };
}

function baseChartOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: "#172335", titleColor: "#e8eef8", bodyColor: "#a9b8cb", borderColor: "rgba(144,164,190,.18)", borderWidth: 1, padding: 9, titleFont: { family: "DM Sans", size: 10 }, bodyFont: { family: "DM Sans", size: 9 } }
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: "#718097", font: { family: "DM Sans", size: 9 } } },
      y: { beginAtZero: true, border: { display: false }, grid: { color: "rgba(144,164,190,.08)" }, ticks: { color: "#718097", precision: 0, font: { family: "DM Sans", size: 8 }, padding: 7 } }
    }
  };
}

function updateCharts() {
  if (!window.Chart) return;
  const series = getDailySeries(state.events);
  const activityData = {
    labels: series.labels,
    datasets: [
      { label: "Successful", data: series.successful, borderColor: "#4c9aff", backgroundColor: "rgba(76,154,255,.13)", fill: true, tension: .38, pointRadius: 2, pointHoverRadius: 4, borderWidth: 2 },
      { label: "Failed", data: series.failed, borderColor: "#fb6474", backgroundColor: "rgba(251,100,116,.06)", fill: false, tension: .38, pointRadius: 2, pointHoverRadius: 4, borderWidth: 1.7 }
    ]
  };
  const activityOptions = baseChartOptions();
  activityOptions.plugins.tooltip.callbacks = { label: (context) => ` ${context.dataset.label}: ${context.parsed.y}` };
  if ($("#activity-chart")) {
    if (state.charts.activity) {
      state.charts.activity.data = activityData;
      state.charts.activity.update();
    } else state.charts.activity = new Chart($("#activity-chart"), { type: "line", data: activityData, options: activityOptions });
  }

  const levels = state.stats.risk_levels || {};
  const riskData = [levels.Low || 0, levels.Medium || 0, levels.High || 0];
  if ($("#risk-chart")) {
    if (state.charts.risk) {
      state.charts.risk.data.datasets[0].data = riskData;
      state.charts.risk.update();
    } else state.charts.risk = new Chart($("#risk-chart"), {
      type: "doughnut",
      data: { labels: ["Low", "Medium", "High"], datasets: [{ data: riskData, backgroundColor: ["#28d99a", "#f7a94b", "#fb6474"], borderColor: "#101927", borderWidth: 4, hoverOffset: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "77%", plugins: { legend: { display: false }, tooltip: { backgroundColor: "#172335", padding: 9 } } }
    });
  }

  [["report-activity-chart", false], ["failed-chart", true]].forEach(([id, failedOnly]) => {
    const canvas = $(`#${id}`);
    if (!canvas) return;
    const data = failedOnly
      ? { labels: series.labels, datasets: [{ label: "Failed attempts", data: series.failedAttempts, borderColor: "#fb6474", backgroundColor: "rgba(251,100,116,.12)", fill: true, tension: .35, pointRadius: 2, borderWidth: 2 }] }
      : activityData;
    if (state.charts[id]) {
      state.charts[id].data = data;
      state.charts[id].update();
    } else state.charts[id] = new Chart(canvas, { type: "line", data, options: baseChartOptions() });
  });
}

function resizeCharts() {
  Object.values(state.charts).forEach((chart) => chart.resize());
}

function renderStats() {
  const { total = 0, successful = 0, failed = 0, suspicious = 0, takeover = 0, risk_levels: levels = {} } = state.stats;
  $("#stat-total").textContent = total.toLocaleString();
  $("#stat-success").textContent = successful.toLocaleString();
  $("#stat-failed").textContent = failed.toLocaleString();
  $("#stat-suspicious").textContent = suspicious.toLocaleString();
  $("#risk-total").textContent = total.toLocaleString();
  $("#risk-low").textContent = levels.Low || 0;
  $("#risk-medium").textContent = levels.Medium || 0;
  $("#risk-high").textContent = levels.High || 0;
  $("#monitor-count").textContent = total;
  $("#alert-count").textContent = state.alerts.filter((alert) => alert.takeover && alert.status !== "Resolved").length;
  $("#open-alert-total").textContent = state.alerts.filter((alert) => alert.takeover && alert.status !== "Resolved").length;
  const failedRows = state.events.filter((event) => event.status === "Failed").length;
  const high = state.events.filter((event) => event.risk_score >= 61).length;
  const medium = state.events.filter((event) => event.risk_score >= 31 && event.risk_score <= 60).length;
  $("#monitor-summary").innerHTML = [
    ["Total events", total], ["Successful", successful], ["Failed", failedRows], ["High risk", high]
  ].map(([label, count]) => `<div class="summary-chip"><span>${label}</span><strong>${count}</strong></div>`).join("");
  $("#alert-metrics").innerHTML = [
    ["Open high-risk incidents", state.alerts.filter((alert) => alert.takeover && alert.status !== "Resolved").length],
    ["Medium-risk alerts", medium],
    ["Resolved incidents", state.alerts.filter((alert) => alert.status === "Resolved").length]
  ].map(([label, count]) => `<div class="summary-chip"><span>${label}</span><strong>${count}</strong></div>`).join("");
  updateCharts();
}

function renderRecentEvents() {
  const events = state.events.slice(0, 5);
  $("#recent-events").innerHTML = events.length ? events.map((event) => `
    <tr>
      <td><span class="user-cell"><span class="user-dot">${escapeHtml(initials(event.username))}</span>${escapeHtml(event.username)}</span></td>
      <td><span class="location-cell"><i data-lucide="map-pin"></i>${escapeHtml(event.location)}</span></td>
      <td>${statusBadge(event.status)}</td><td>${riskBadge(event.risk_level)}</td>
      <td>${escapeHtml(relativeTime(event.login_time))}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="no-alerts">No login events yet.</td></tr>`;
}

function renderAlerts() {
  const active = state.alerts.filter((alert) => alert.status !== "Resolved");
  $("#dashboard-alerts").innerHTML = active.length ? active.slice(0, 4).map((alert) => `
    <div class="alert-row">
      <span class="alert-symbol ${alert.severity === "Medium" ? "medium" : ""}"><i data-lucide="${alert.takeover ? "shield-alert" : "map-pin"}"></i></span>
      <span class="alert-content"><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.username)} · ${escapeHtml(alert.ip_address)}</small></span>
      <span class="alert-time">${escapeHtml(relativeTime(alert.created_at))}</span>
    </div>`).join("") : `<div class="no-alerts">No open alerts. Your demo environment is clear.</div>`;

  const incidents = state.alerts.filter((alert) => alert.takeover);
  $("#takeover-list").innerHTML = incidents.length ? incidents.map((alert) => {
    const high = alert.severity === "High";
    const resolved = alert.status === "Resolved";
    return `<article class="incident-card ${high ? "" : "medium-incident"}">
      <div class="incident-heading"><div class="incident-title"><span class="incident-icon ${high ? "" : "medium"}"><i data-lucide="${high ? "shield-alert" : "triangle-alert"}"></i></span><div><h3>${escapeHtml(alert.title)}</h3><p>${escapeHtml(alert.username)} · Alert ${escapeHtml(`#${alert.id}`)} · ${escapeHtml(relativeTime(alert.created_at))}</p></div></div>${riskBadge(alert.severity, alert.risk_score)}</div>
      <div class="incident-body">
        <div class="incident-field"><small>IP ADDRESS</small><strong>${escapeHtml(alert.ip_address)}</strong></div>
        <div class="incident-field"><small>LOCATION</small><strong>${escapeHtml(alert.location)}</strong></div>
        <div class="incident-field"><small>DEVICE</small><strong>${escapeHtml(alert.device)}</strong></div>
        <div class="incident-field"><small>FAILED ATTEMPTS</small><strong>${escapeHtml(alert.failed_attempts)}</strong></div>
      </div>
      <div class="incident-reasons">${(alert.reasons || []).map((reason) => `<span class="reason-tag ${high ? "" : "medium-tag"}">${escapeHtml(reason)}</span>`).join("")}</div>
      <div class="incident-actions">
        <button class="action-button" data-alert-action="Investigating" data-alert-id="${alert.id}" ${resolved ? "disabled" : ""}><i data-lucide="clipboard-check"></i>Mark as investigated</button>
        <button class="action-button danger-action" data-alert-action="Blocked (simulated)" data-alert-id="${alert.id}" ${resolved ? "disabled" : ""}><i data-lucide="ban"></i>Block login <span class="simulated-label">(simulated)</span></button>
        <button class="action-button" data-alert-action="Password reset (simulated)" data-alert-id="${alert.id}" ${resolved ? "disabled" : ""}><i data-lucide="key-round"></i>Reset password <span class="simulated-label">(simulated)</span></button>
        <button class="action-button success-action" data-alert-action="Resolved" data-alert-id="${alert.id}" ${resolved ? "disabled" : ""}><i data-lucide="circle-check"></i>Resolve alert</button>
        <span class="alert-status ${resolved ? "resolved" : ""}">${escapeHtml(alert.status)}</span>
      </div>
    </article>`;
  }).join("") : `<div class="empty-state"><i data-lucide="shield-check"></i><strong>No takeover incidents detected</strong><p>High-risk login alerts will appear here for investigation.</p></div>`;
}

function renderEventsTable() {
  const query = $("#event-search").value.trim().toLowerCase();
  const risk = $("#risk-filter").value;
  const status = $("#status-filter").value;
  const events = state.events.filter((event) => {
    const haystack = [event.username, event.ip_address, event.location, event.device].join(" ").toLowerCase();
    return (!query || haystack.includes(query)) && (!risk || event.risk_level === risk) && (!status || event.status === status);
  });
  $("#events-table").innerHTML = events.map((event) => `
    <tr>
      <td><span class="user-cell"><span class="user-dot">${escapeHtml(initials(event.username))}</span>${escapeHtml(event.username)}</span></td>
      <td>${escapeHtml(event.ip_address)}</td><td><span class="location-cell"><i data-lucide="map-pin"></i>${escapeHtml(event.location)}</span></td>
      <td>${escapeHtml(event.device)}</td><td>${escapeHtml(localDate(event.login_time, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</td>
      <td>${statusBadge(event.status)}</td><td>${riskBadge(event.risk_level, event.risk_score)}</td>
    </tr>`).join("");
  $("#events-empty").classList.toggle("hidden", events.length > 0);
}

function renderReports() {
  const byUser = new Map();
  for (const event of state.events) {
    if (event.risk_score < 61) continue;
    const previous = byUser.get(event.username);
    if (!previous || event.risk_score > previous.risk_score) byUser.set(event.username, event);
  }
  const highRisk = [...byUser.values()].sort((a, b) => b.risk_score - a.risk_score);
  $("#high-risk-table").innerHTML = highRisk.length ? highRisk.map((event) => `
    <tr><td><span class="user-cell"><span class="user-dot">${escapeHtml(initials(event.username))}</span>${escapeHtml(event.username)}</span></td>
    <td>${escapeHtml(event.ip_address)}</td><td>${escapeHtml(event.location)}</td>
    <td>${escapeHtml((event.reasons || []).join(", ") || "Elevated behavioral risk")}</td><td>${riskBadge(event.risk_level, event.risk_score)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="no-alerts">No high-risk accounts in the current dataset.</td></tr>`;
  updateCharts();
}

async function refreshData() {
  const [events, alerts, stats] = await Promise.all([api("/api/events"), api("/api/alerts"), api("/api/stats")]);
  state.events = events;
  state.alerts = alerts;
  state.stats = stats;
  renderStats();
  renderRecentEvents();
  renderAlerts();
  renderEventsTable();
  renderReports();
  if (window.lucide) lucide.createIcons();
}

async function analyzeLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const values = Object.fromEntries(new FormData(form).entries());
  values.failed_attempts = Number(values.failed_attempts || 0);
  button.disabled = true;
  button.innerHTML = `<i data-lucide="loader-circle"></i> Analyzing signals...`;
  if (window.lucide) lucide.createIcons();
  try {
    const result = await api("/api/analyze", { method: "POST", body: JSON.stringify(values) });
    const color = result.level === "High" ? "var(--red)" : result.level === "Medium" ? "var(--orange)" : "var(--green)";
    $("#analysis-result").innerHTML = `<div class="result-content">
      <div class="result-top"><div><div class="result-kicker">RISK ASSESSMENT · EVENT #${escapeHtml(result.id)}</div><h2>${escapeHtml(result.username)}</h2></div>${riskBadge(result.level)}</div>
      <div class="result-meter"><div class="meter-ring" style="color:${color}"><strong>${escapeHtml(result.score)}</strong></div><div class="meter-meta"><span>Overall risk score</span><strong style="color:${color}">${escapeHtml(result.level)} risk</strong><small>Calculated from ${result.reasons.length} detection signal${result.reasons.length === 1 ? "" : "s"}</small></div></div>
      <div class="result-section-title">Detection reasons <small>${result.reasons.length} signal${result.reasons.length === 1 ? "" : "s"} found</small></div>
      <div class="reason-list">${result.reasons.length ? result.reasons.map((reason) => `<div class="reason-item"><i data-lucide="triangle-alert"></i>${escapeHtml(reason)}</div>`).join("") : `<div class="no-reasons">No suspicious activity detected in this sign-in.</div>`}</div>
      <div class="recommend-wrap"><div class="result-section-title">Recommended security actions</div><div class="recommend-list">${result.recommended_actions.map((action) => `<div class="recommend-item"><i data-lucide="arrow-up-right"></i>${escapeHtml(action)}</div>`).join("")}</div></div>
    </div>`;
    await refreshData();
    toast(result.score >= 31 ? "Login analyzed. A new security alert was created." : "Login analyzed and saved to monitoring.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = `<i data-lucide="scan-search"></i> Analyze login <i data-lucide="arrow-right"></i>`;
    if (window.lucide) lucide.createIcons();
  }
}

async function setAlertAction(button) {
  button.disabled = true;
  try {
    const result = await api(`/api/alerts/${button.dataset.alertId}`, {
      method: "PATCH", body: JSON.stringify({ status: button.dataset.alertAction })
    });
    await refreshData();
    const labels = {
      "Investigating": "Alert marked as investigated.",
      "Blocked (simulated)": "Login blocked (simulated only).",
      "Password reset (simulated)": "Password reset recorded (simulated only).",
      "Resolved": "Alert resolved."
    };
    toast(labels[result.status] || "Alert updated.");
  } catch (error) {
    button.disabled = false;
    toast(error.message, true);
  }
}

function localInputDate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function setupInteractions() {
  $$(".nav-link").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(link.dataset.page);
  }));
  $$("[data-navigate]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.navigate)));
  $("#notification-button").addEventListener("click", () => navigate("takeover"));
  $("#menu-button").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  document.addEventListener("click", (event) => {
    if (window.innerWidth <= 600 && $("#sidebar").classList.contains("open") && !$("#sidebar").contains(event.target) && !$("#menu-button").contains(event.target)) $("#sidebar").classList.remove("open");
  });
  $("#analysis-form").addEventListener("submit", analyzeLogin);
  $("#event-search").addEventListener("input", renderEventsTable);
  $("#risk-filter").addEventListener("change", renderEventsTable);
  $("#status-filter").addEventListener("change", renderEventsTable);
  $("#monitor-export").addEventListener("click", () => { window.location.href = "/api/export"; });
  $("#takeover-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-alert-action]");
    if (button && !button.disabled) setAlertAction(button);
  });
  $("#reset-button").addEventListener("click", () => $("#confirm-modal").classList.remove("hidden"));
  $("#cancel-reset").addEventListener("click", () => $("#confirm-modal").classList.add("hidden"));
  $("#confirm-modal").addEventListener("click", (event) => {
    if (event.target === $("#confirm-modal")) $("#confirm-modal").classList.add("hidden");
  });
  $("#confirm-reset").addEventListener("click", async () => {
    const button = $("#confirm-reset");
    button.disabled = true;
    try {
      await api("/api/reset", { method: "POST" });
      await refreshData();
      $("#analysis-result").innerHTML = `<div class="result-placeholder"><span class="placeholder-icon"><i data-lucide="scan-line"></i></span><h2>Ready to analyze</h2><p>Submit a simulated login to see its risk score, detection reasons, and recommended actions.</p><div class="placeholder-points"><span><i data-lucide="check"></i> Behavioral signals</span><span><i data-lucide="check"></i> Explainable results</span><span><i data-lucide="check"></i> Actionable guidance</span></div></div>`;
      $("#confirm-modal").classList.add("hidden");
      toast("Demo data restored to its original state.");
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
      if (window.lucide) lucide.createIcons();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $("#confirm-modal").classList.add("hidden");
      $("#sidebar").classList.remove("open");
    }
  });
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
  window.addEventListener("resize", resizeCharts);
}

async function init() {
  $("#current-date").textContent = localDate(new Date(), { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  $("#login-time-input").value = localInputDate();
  setupInteractions();
  if (window.lucide) lucide.createIcons();
  try {
    await refreshData();
    navigate(location.hash.slice(1) || "dashboard");
  } catch (error) {
    toast(`Could not load SecureGuard data: ${error.message}`, true);
  }
}

document.addEventListener("DOMContentLoaded", init);
