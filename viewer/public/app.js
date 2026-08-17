import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

function App() {
  const [catalog, setCatalog] = useState(null);
  const [selectedAction, setSelectedAction] = useState(null);
  const [selectedFlowKey, setSelectedFlowKey] = useState(null);
  const [flowDetail, setFlowDetail] = useState(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedScreen, setSelectedScreen] = useState(null);

  async function refreshCatalog() {
    setLoading(true);
    setError(null);
    try {
      const nextCatalog = await fetchJson("/api/catalog");
      setCatalog(nextCatalog);
      const firstAction = nextCatalog.actions[0]?.actionSlug || null;
      setSelectedAction((current) =>
        current && nextCatalog.actions.some((action) => action.actionSlug === current) ? current : firstAction,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshCatalog();
  }, []);

  const action = useMemo(
    () => catalog?.actions.find((candidate) => candidate.actionSlug === selectedAction) || catalog?.actions[0] || null,
    [catalog, selectedAction],
  );

  const filteredFlows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const flows = action?.flows || [];
    if (!needle) return flows;
    return flows.filter((flow) =>
      [flow.appName, flow.flowName, flow.title, flow.flowId].filter(Boolean).join(" ").toLowerCase().includes(needle),
    );
  }, [action, query]);

  const selectedFlow = useMemo(() => {
    if (!selectedFlowKey) return filteredFlows[0] || null;
    return filteredFlows.find((flow) => flow.folder === selectedFlowKey) || filteredFlows[0] || null;
  }, [filteredFlows, selectedFlowKey]);

  useEffect(() => {
    if (!selectedFlow) {
      setFlowDetail(null);
      return;
    }
    let canceled = false;
    fetchJson(`/api/flow?action=${encodeURIComponent(selectedFlow.actionSlug)}&folder=${encodeURIComponent(selectedFlow.folder)}`)
      .then((detail) => {
        if (!canceled) setFlowDetail(detail);
      })
      .catch(() => {
        if (!canceled) setFlowDetail(null);
      });
    return () => {
      canceled = true;
    };
  }, [selectedFlow?.actionSlug, selectedFlow?.folder]);

  if (loading && !catalog) return h("main", { className: "empty" }, "Loading local Mobbin export…");
  if (error) return h("main", { className: "empty" }, `Could not load catalog: ${error}`);

  return h(
    "div",
    { className: "app-shell" },
    h(
      "aside",
      { className: "sidebar" },
      h("div", { className: "brand" }, h("div", { className: "mark" }, "M"), h("div", null, h("strong", null, "Mobbin Sides"), h("span", null, "Local export viewer"))),
      h("button", { className: "refresh", onClick: refreshCatalog }, "Refresh directory"),
      h("div", { className: "stats" },
        stat("Actions", catalog.actionCount),
        stat("Flows", catalog.totalFlows),
        stat("Screens", catalog.totalScreens),
        stat("Saved", catalog.totalSavedImages),
      ),
      h("nav", { className: "actions" }, ...(catalog.actions || []).map((item) =>
        h(
          "button",
          {
            key: item.actionSlug,
            className: item.actionSlug === action?.actionSlug ? "active" : "",
            onClick: () => {
              setSelectedAction(item.actionSlug);
              setSelectedFlowKey(null);
            },
          },
          h("span", null, item.actionName),
          h("small", null, `${item.flows.length}${item.reportComplete ? "" : " running"}`),
        ),
      )),
    ),
    h(
      "main",
      { className: "content" },
      h(
        "header",
        { className: "topbar" },
        h("div", null,
          h("p", { className: "eyebrow" }, "Flow action"),
          h("h1", null, action?.actionName || "No flows yet"),
        ),
        h("input", {
          className: "search",
          value: query,
          onChange: (event) => setQuery(event.target.value),
          placeholder: "Search app, flow, or id…",
        }),
      ),
      action && h("section", { className: "action-summary" },
        pill("Exported flows", action.exportedFlowCount ?? action.flows.length),
        pill("Saved images", action.savedImageCount),
        pill("Advertised", action.advertisedFlowCount ?? "—"),
        pill("Pagination", action.paginationComplete === false ? "first page only" : "complete"),
      ),
      h(
        "section",
        { className: "workspace" },
        h(
          "div",
          { className: "flow-grid" },
          ...filteredFlows.map((flow) =>
            h(FlowCard, {
              key: `${flow.actionSlug}/${flow.folder}`,
              flow,
              selected: selectedFlow?.folder === flow.folder,
              onSelect: () => {
                setSelectedFlowKey(flow.folder);
                setSelectedScreen(null);
                setTimeout(() => {
                  document.querySelector(".detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                }, 0);
              },
            }),
          ),
        ),
        h(FlowDetail, { flow: flowDetail || selectedFlow, onOpenScreen: setSelectedScreen }),
      ),
      selectedScreen &&
        h(ScreenLightbox, {
          screen: selectedScreen.screen,
          flow: selectedScreen.flow,
          onClose: () => setSelectedScreen(null),
        }),
    ),
  );
}

function FlowCard({ flow, selected, onSelect }) {
  return h(
    "button",
    { className: `flow-card ${selected ? "selected" : ""}`, onClick: onSelect },
    h("div", { className: "thumb-strip" },
      ...(flow.thumbnails || []).slice(0, 4).map((src, index) =>
        h("img", { key: `${src}-${index}`, src, alt: "", loading: "lazy" }),
      ),
      !flow.thumbnails?.length && h("div", { className: "placeholder" }, "No image yet"),
    ),
    h("div", { className: "flow-meta" },
      h("strong", null, flow.flowName || flow.title),
      h("span", null, flow.appName),
      h("small", null, `${flow.savedImageCount}/${flow.screenCount} screens${flow.complete ? "" : " · in progress"}`),
      h("em", null, "Click to open flow"),
    ),
  );
}

function FlowDetail({ flow, onOpenScreen }) {
  if (!flow) return h("aside", { className: "detail empty-detail" }, "Select a flow");
  const screens = flow.screens || [];
  return h(
    "aside",
    { className: "detail" },
    h("div", { className: "detail-header" },
      h("p", { className: "eyebrow" }, flow.appName || "Unknown app"),
      h("h2", null, flow.flowName || flow.title || "Untitled flow"),
      h("p", null, `${flow.savedImageCount || 0}/${flow.screenCount || screens.length || 0} screens saved`),
    ),
    h(
      "div",
      { className: "screen-rail" },
      ...screens.map((screen) =>
        h("figure", { key: `${screen.screenId}-${screen.index}`, className: "phone-frame" },
          h(
            "button",
            {
              className: "screen-button",
              disabled: !screen.assetUrl,
              onClick: () => screen.assetUrl && onOpenScreen({ flow, screen }),
              title: screen.assetUrl ? "Open screen full size" : "Missing image",
            },
            screen.assetUrl
              ? h("img", {
                  src: screen.assetUrl,
                  alt: `${flow.flowName || "Flow"} screen ${screen.index}`,
                  loading: "lazy",
                })
              : h("div", { className: "missing" }, screen.error || "Missing image"),
            screen.assetUrl && h("span", { className: "open-screen" }, "Open"),
          ),
          h("figcaption", null, `${String(screen.index || screen.order).padStart(2, "0")} · ${screen.screenId || ""}`),
        ),
      ),
    ),
  );
}

function ScreenLightbox({ flow, screen, onClose }) {
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return h(
    "div",
    { className: "lightbox", role: "dialog", "aria-modal": "true", onClick: onClose },
    h(
      "div",
      { className: "lightbox-card", onClick: (event) => event.stopPropagation() },
      h(
        "header",
        { className: "lightbox-header" },
        h("div", null,
          h("p", { className: "eyebrow" }, `${flow.appName || "Unknown app"} · screen ${screen.index || screen.order}`),
          h("h2", null, flow.flowName || "Untitled flow"),
        ),
        h("button", { className: "close", onClick: onClose, "aria-label": "Close full-screen preview" }, "Close"),
      ),
      h("img", {
        className: "lightbox-image",
        src: screen.assetUrl,
        alt: `${flow.flowName || "Flow"} screen ${screen.index || screen.order}`,
      }),
      h("footer", { className: "lightbox-footer" },
        h("span", null, screen.screenId || ""),
        h("a", { href: screen.assetUrl, target: "_blank", rel: "noreferrer" }, "Open image in new tab"),
      ),
    ),
  );
}

function stat(label, value) {
  return h("div", { className: "stat" }, h("strong", null, formatNumber(value)), h("span", null, label));
}

function pill(label, value) {
  return h("div", { className: "pill" }, h("span", null, label), h("strong", null, formatNumber(value)));
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "—") return "—";
  return typeof value === "number" ? new Intl.NumberFormat().format(value) : String(value);
}

createRoot(document.getElementById("root")).render(h(App));
