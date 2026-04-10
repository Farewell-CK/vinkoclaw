import { login, redirectIfAuthenticated } from "./auth.js";

const I18N = {
  zh: {
    "login.title": "欢迎回来",
    "login.subtitle": "登录以访问 OPC 指挥中心",
    "login.username": "用户名",
    "login.usernamePlaceholder": "请输入用户名",
    "login.password": "密码",
    "login.passwordPlaceholder": "请输入密码",
    "login.remember": "记住登录状态",
    "login.submit": "登 录",
    "login.error.empty": "请输入用户名和密码",
    "login.error.invalid": "用户名或密码错误",
    "login.error.network": "网络错误，请稍后重试",
    "login.error.unknown": "登录失败，请重试"
  },
  en: {
    "login.title": "Welcome Back",
    "login.subtitle": "Sign in to access the OPC Command Room",
    "login.username": "Username",
    "login.usernamePlaceholder": "Enter your username",
    "login.password": "Password",
    "login.passwordPlaceholder": "Enter your password",
    "login.remember": "Remember me",
    "login.submit": "Sign In",
    "login.error.empty": "Please enter username and password",
    "login.error.invalid": "Invalid username or password",
    "login.error.network": "Network error, please try again",
    "login.error.unknown": "Login failed, please try again"
  }
};

let currentLang = localStorage.getItem("vinkoclaw.lang") === "en" ? "en" : "zh";

function t(key) {
  const primary = I18N[currentLang] || I18N.en;
  const fallback = I18N.en;
  return primary[key] || fallback[key] || key;
}

function applyI18n() {
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key) el.setAttribute("placeholder", t(key));
  });
}

function showError(messageKey) {
  const el = document.getElementById("login-error");
  if (el) el.textContent = t(messageKey);
}

function clearError() {
  const el = document.getElementById("login-error");
  if (el) el.textContent = "";
}

function setLoading(isLoading) {
  const btn = document.querySelector("#login-form button[type=\"submit\"]");
  const inputs = document.querySelectorAll("#login-form input");
  if (btn) {
    btn.disabled = isLoading;
    btn.textContent = isLoading
      ? (currentLang === "zh" ? "登录中..." : "Signing in...")
      : t("login.submit");
  }
  inputs.forEach((input) => { input.disabled = isLoading; });
}

function getRedirectUrl() {
  const params = new URLSearchParams(window.location.search);
  const redirect = params.get("redirect");
  if (redirect && redirect.startsWith("/") && !redirect.startsWith("//")) return redirect;
  return "/";
}

async function handleLogin(event) {
  event.preventDefault();
  clearError();
  const form = event.target;
  const username = form.querySelector("#username").value.trim();
  const password = form.querySelector("#password").value;
  const remember = form.querySelector("#remember").checked;
  if (!username || !password) {
    showError("login.error.empty");
    return;
  }
  setLoading(true);
  const result = await login(username, password, remember);
  if (!result.success) {
    setLoading(false);
    if (result.error?.includes("Invalid") || result.error?.includes("unauthorized")) {
      showError("login.error.invalid");
    } else if (result.error?.includes("Network") || result.error?.includes("fetch")) {
      showError("login.error.network");
    } else {
      showError("login.error.unknown");
    }
    return;
  }
  window.location.href = getRedirectUrl();
}

function init() {
  redirectIfAuthenticated();
  applyI18n();
  const form = document.getElementById("login-form");
  if (form) form.addEventListener("submit", handleLogin);
  const params = new URLSearchParams(window.location.search);
  const errorParam = params.get("error");
  if (errorParam) {
    showError(errorParam === "session_expired" ? "login.error.sessionExpired" : "login.error.unknown");
  }
}

init();
