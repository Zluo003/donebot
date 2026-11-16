const menuButton = document.querySelector("[data-menu-toggle]");
const navigation = document.querySelector("[data-navigation]");

if (menuButton && navigation) {
  menuButton.addEventListener("click", () => {
    const open = navigation.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(open));
  });

  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) {
      navigation.classList.remove("open");
      menuButton.setAttribute("aria-expanded", "false");
    }
  });
}

const toast = document.querySelector("[data-toast]");
let toastTimer;

document.querySelectorAll("[data-download]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!toast) return;
    toast.textContent = `${button.dataset.download} 下载入口暂未开放。`;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2800);
  });
});
