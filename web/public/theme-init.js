try {
    var themeStore = JSON.parse(localStorage.getItem("infinite-canvas:theme_store") || "{}");
    var initialTheme = themeStore.state && themeStore.state.theme === "light" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", initialTheme === "dark");
    document.documentElement.style.colorScheme = initialTheme;
} catch (_) {}
