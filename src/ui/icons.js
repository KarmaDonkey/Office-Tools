// Ikoner från Lucide (ISC-licens), inbäddade vid bygget.
const files = import.meta.glob("/node_modules/lucide-static/icons/{file-text,folder-open,save,save-all,undo-2,redo-2,mouse-pointer-2,highlighter,type,pen-line,signature,square-dashed,eraser,zoom-in,zoom-out,search,rotate-ccw,rotate-cw,trash-2,file-output,scissors,combine,images,image,file-image,file-archive,stamp,hash,info,lock,lock-open,sun,moon,monitor,x,chevron-up,chevron-down,chevron-left,chevron-right,panel-left,layout-grid,menu,settings,file-plus,ellipsis-vertical,eye-off,check,maximize-2,move-horizontal,clock,download,file-down,plus,wrench,shield-check,file-x,arrow-left-right,minimize-2,upload}.svg", { query: "?raw", import: "default", eager: true });

const svgs = {};
for (const [path, svg] of Object.entries(files)) {
  const name = path.split("/").pop().replace(".svg", "");
  svgs[name] = svg;
}

const template = document.createElement("template");

export function icon(name) {
  const svg = svgs[name];
  if (!svg) {
    console.warn("Saknad ikon", name);
    return document.createElement("span");
  }
  template.innerHTML = svg.trim();
  const el = template.content.firstElementChild.cloneNode(true);
  el.removeAttribute("width");
  el.removeAttribute("height");
  el.setAttribute("class", "icon");
  el.setAttribute("aria-hidden", "true");
  el.removeAttribute("data-lucide");
  return el;
}
