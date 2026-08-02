/**
 * Document serialization, shared by the in-page SDK and Node tests.
 *
 * Everything human-review adds to a live page — the overlay, highlight marks, the
 * injected style/script, contenteditable — must vanish on the way back to disk,
 * so the saved file renders exactly as it does standalone.
 */

export const UI_ATTR = "data-eh-ui";
export const MARK_ATTR = "data-eh-mark";

/** Keep a hydrated app editable even if its framework removes the attribute. */
export function keepBodyEditable(body) {
  const enforce = () => {
    if (body.getAttribute("contenteditable") !== "true") {
      body.setAttribute("contenteditable", "true");
    }
  };
  enforce();
  const Observer = body.ownerDocument.defaultView.MutationObserver;
  const observer = new Observer(enforce);
  observer.observe(body, { attributes: true, attributeFilter: ["contenteditable"] });
  return observer;
}

/** Serialize a document to the HTML that should live on disk. */
export function serializeDocument(doc) {
  const clone = doc.documentElement.cloneNode(true);
  clone.querySelectorAll(`[${UI_ATTR}]`).forEach((n) => n.remove());
  clone.querySelectorAll("script[data-eh-sdk], style[data-eh-sdk]").forEach((n) => n.remove());
  clone.querySelectorAll(`mark[${MARK_ATTR}]`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  const body = clone.querySelector("body");
  if (body) {
    body.removeAttribute("contenteditable");
    body.removeAttribute("spellcheck");
  }
  clone.normalize();
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "";
  return `${doctype}${clone.outerHTML}\n`;
}
