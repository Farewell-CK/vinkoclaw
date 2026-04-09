import {
  login,
  redirectIfAuthenticated,
  type AuthUser
} from "./auth.js";

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

function t(key: string): string {
  const primary = I18N[currentLang] || I18N.en;
  const fallback = I18N.en;
  return primary[key] || fallback[key] || key;
}

function applyI18n(): void {
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    if (key) {
      element.textContent = t(key);
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-i18n-placeholder");
    if (key) {
      element.setAttribute("placeholder", t(key));
    }
  });
}

function showError(messageKey: string): void {
  const errorElement = document.querySelector("#login-error") as HTMLElement;
  if (errorElement) {
    errorElement.textContent = t(messageKey);
  }
}

function clearError(): void {
  const errorElement = document.querySelector("#login-error") as HTMLElement;
  if (errorElement) {
    errorElement.textContent = "";
  }
}

function setLoading(isLoading: boolean): void {
  const submitBtn = document.querySelector("#login-form button[type=\"submit\"]") as HTMLButtonElement;
  const inputs = document.querySelectorAll("#login-form input");

  if (submitBtn) {
    submitBtn.disabled = isLoading;
    submitBtn.textContent = isLoading
      ? (currentLang === "zh" ? "登录中..." : "Signing in...")
      : t("login.submit");
  }

  inputs.forEach((input) => {
    (input as HTMLInputElement).disabled = isLoading;
  });
}

function getRedirectUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const redirect = params.get("redirect");
  if (redirect && redirect.startsWith("/") && !redirect.startsWith("//")) {
    return redirect;
  }
  return "/";
}

async function handleLogin(event: Event): Promise<void> {
  event.preventDefault();
  clearError();

  const form = event.target as HTMLFormElement;
  const username = (form.querySelector("#username") as HTMLInputElement).value.trim();
  const password = (form.querySelector("#password") as HTMLInputElement).value;
  const remember = (form.querySelector("#remember") as HTMLInputElement).checked;

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

function init(): void {
  redirectIfAuthenticated();

  applyI18n();

  const form = document.querySelector("#login-form");
  if (form) {
    form.addEventListener("submit", handleLogin);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const errorParam = urlParams.get("error");
  if (errorParam) {
    showError(errorParam === "session_expired" ? "login.error.sessionExpired" : "login.error.unknown");
  }
}

init();
