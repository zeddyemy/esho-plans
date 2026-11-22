for (const time of document.querySelectorAll("time[datetime]")) {
  const date = new Date(time.dateTime);
  if (!Number.isNaN(date.valueOf())) time.textContent = date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

for (const input of document.querySelectorAll("[data-list-filter]")) {
  const list = document.getElementById(input.getAttribute("aria-controls"));
  const empty = document.querySelector("[data-empty-filter]");
  if (!list || !empty) continue;
  input.addEventListener("input", () => {
    const query = input.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const entry of list.children) {
      const title = entry.querySelector("a")?.textContent ?? "";
      entry.hidden = !title.toLocaleLowerCase().includes(query);
      if (!entry.hidden) matches += 1;
    }
    empty.hidden = matches > 0;
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const input = document.getElementById(button.dataset.copy);
    const status = document.querySelector("[data-copy-status]");
    if (!input || !status) return;
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = "Copied to clipboard.";
    } catch {
      input.focus();
      input.select();
      status.textContent = "Press your copy shortcut to copy the selection.";
    }
  });
}

for (const form of document.querySelectorAll("[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
}
