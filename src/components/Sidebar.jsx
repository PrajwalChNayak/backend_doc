import { useEffect, useRef, useState } from "react";
import {
  FiBook,
  FiCheck,
  FiChevronDown,
  FiChevronRight,
  FiChevronsLeft,
  FiChevronsRight,
  FiCircle,
} from "react-icons/fi";

const Sidebar = ({
  docs,
  activeCategoryId,
  activeSectionId,
  isOpen,
  onClose,
  onNavigate,
}) => {
  const [expanded, setExpanded] = useState(() => new Set([activeCategoryId]));
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [readSections, setReadSections] = useState(() => {
    const saved = localStorage.getItem("readSections");
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });
  const activeSectionRef = useRef(null);

  // Auto-expand active category and scroll to active section
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (activeCategoryId) next.add(activeCategoryId);
      return next;
    });
  }, [activeCategoryId]);

  // Scroll active section into view
  useEffect(() => {
    if (activeSectionRef.current) {
      activeSectionRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activeSectionId]);

  // Mark section as read when viewed
  useEffect(() => {
    if (activeCategoryId && activeSectionId) {
      const key = `${activeCategoryId}:${activeSectionId}`;
      setReadSections((prev) => {
        const next = new Set(prev);
        next.add(key);
        localStorage.setItem("readSections", JSON.stringify([...next]));
        return next;
      });
    }
  }, [activeCategoryId, activeSectionId]);

  const toggleCategory = (categoryId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  const handleNavigate = (categoryId, sectionId) => {
    onNavigate?.({ categoryId, sectionId });
    onClose?.();
  };

  // Calculate progress for a category
  const getCategoryProgress = (category) => {
    const total = category.sections.length;
    const read = category.sections.filter((s) =>
      readSections.has(`${category.id}:${s.id}`)
    ).length;
    return { read, total, percentage: Math.round((read / total) * 100) };
  };

  // Get current section index for navigation indicator
  const getCurrentSectionIndex = (category) => {
    if (category.id !== activeCategoryId) return -1;
    return category.sections.findIndex((s) => s.id === activeSectionId);
  };

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={`fixed inset-0 z-30 bg-slate-900/60 backdrop-blur-sm transition lg:hidden ${
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />

      {/* Sidebar */}
      <aside
        className={`group/sidebar fixed left-0 top-0 z-40 flex h-full transform flex-col border-r border-slate-200/50 bg-gradient-to-b from-slate-50 to-white transition-all duration-300 dark:border-slate-700/50 dark:from-slate-900 dark:to-slate-800 lg:sticky lg:top-0 lg:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        } ${isCollapsed ? "w-16" : "w-72"}`}
      >
        {/* Header */}
        <div
          className={`flex items-center border-b border-slate-200/50 p-4 dark:border-slate-700/50 ${
            isCollapsed ? "justify-center" : "justify-between"
          }`}
        >
          {!isCollapsed && (
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-purple-600 text-white shadow-lg shadow-brand-500/25">
                <FiBook className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-bold text-slate-800 dark:text-white">
                  Docs
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Backend Guide
                </p>
              </div>
            </div>
          )}

          {/* Collapse toggle button */}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="hidden rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-300 lg:flex"
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isCollapsed ? (
              <FiChevronsRight className="h-4 w-4" />
            ) : (
              <FiChevronsLeft className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-600">
          <div className="space-y-2">
            {docs.categories.map((category) => {
              const isActiveCategory = category.id === activeCategoryId;
              const isExpanded = expanded.has(category.id);
              const progress = getCategoryProgress(category);
              const currentIndex = getCurrentSectionIndex(category);

              return (
                <div
                  key={category.id}
                  className={`overflow-hidden rounded-xl transition-all ${
                    isActiveCategory
                      ? "bg-brand-50/50 ring-1 ring-brand-200 dark:bg-brand-900/20 dark:ring-brand-800"
                      : "hover:bg-slate-100/50 dark:hover:bg-slate-800/50"
                  }`}
                >
                  {/* Category header */}
                  <button
                    type="button"
                    onClick={() => toggleCategory(category.id)}
                    className={`group flex w-full items-center gap-3 px-3 py-3 text-left transition ${
                      isCollapsed ? "justify-center" : "justify-between"
                    }`}
                    title={isCollapsed ? category.title : undefined}
                  >
                    <span className="flex items-center gap-3">
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg transition ${
                          isActiveCategory
                            ? "bg-brand-500 text-white shadow-md shadow-brand-500/30"
                            : "bg-slate-200/70 text-slate-600 group-hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:group-hover:bg-slate-600"
                        }`}
                      >
                        {category.icon}
                      </span>
                      {!isCollapsed && (
                        <div className="min-w-0 flex-1">
                          <span
                            className={`block truncate font-semibold ${
                              isActiveCategory
                                ? "text-brand-700 dark:text-brand-300"
                                : "text-slate-700 dark:text-slate-200"
                            }`}
                          >
                            {category.title}
                          </span>
                          {/* Progress indicator */}
                          <div className="mt-1 flex items-center gap-2">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-brand-500 to-purple-500 transition-all duration-500"
                                style={{ width: `${progress.percentage}%` }}
                              />
                            </div>
                            <span className="text-[10px] font-medium text-slate-400">
                              {progress.read}/{progress.total}
                            </span>
                          </div>
                        </div>
                      )}
                    </span>
                    {!isCollapsed && (
                      <FiChevronDown
                        className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${
                          isExpanded ? "rotate-180" : "rotate-0"
                        }`}
                      />
                    )}
                  </button>

                  {/* Sections list */}
                  {!isCollapsed && (
                    <div
                      className={`grid transition-all duration-300 ease-in-out ${
                        isExpanded
                          ? "grid-rows-[1fr] opacity-100"
                          : "grid-rows-[0fr] opacity-0"
                      }`}
                    >
                      <ul className="min-h-0 overflow-hidden">
                        <div className="relative space-y-0.5 pb-3 pl-6 pr-3">
                          {/* Vertical progress line */}
                          <div className="absolute bottom-3 left-[22px] top-0 w-0.5 rounded-full bg-slate-200 dark:bg-slate-700">
                            {currentIndex >= 0 && (
                              <div
                                className="absolute left-0 top-0 w-full rounded-full bg-gradient-to-b from-brand-500 to-purple-500 transition-all duration-300"
                                style={{
                                  height: `${
                                    ((currentIndex + 1) /
                                      category.sections.length) *
                                    100
                                  }%`,
                                }}
                              />
                            )}
                          </div>

                          {category.sections.map((section, index) => {
                            const isActiveSection =
                              isActiveCategory &&
                              section.id === activeSectionId;
                            const isRead = readSections.has(
                              `${category.id}:${section.id}`
                            );
                            const isPastCurrent =
                              currentIndex >= 0 && index <= currentIndex;

                            return (
                              <li
                                key={section.id}
                                ref={isActiveSection ? activeSectionRef : null}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleNavigate(category.id, section.id)
                                  }
                                  className={`group/item relative flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-all ${
                                    isActiveSection
                                      ? "bg-white text-brand-700 shadow-sm ring-1 ring-brand-200 dark:bg-slate-800 dark:text-brand-300 dark:ring-brand-700"
                                      : "text-slate-600 hover:bg-white/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-200"
                                  }`}
                                >
                                  {/* Status indicator dot */}
                                  <span
                                    className={`relative z-10 mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-all ${
                                      isActiveSection
                                        ? "bg-brand-500 text-white ring-4 ring-brand-100 dark:ring-brand-900"
                                        : isRead
                                        ? "bg-green-500 text-white"
                                        : isPastCurrent
                                        ? "bg-brand-400 text-white"
                                        : "bg-slate-300 dark:bg-slate-600"
                                    }`}
                                  >
                                    {isActiveSection ? (
                                      <FiChevronRight className="h-2.5 w-2.5" />
                                    ) : isRead ? (
                                      <FiCheck className="h-2.5 w-2.5" />
                                    ) : (
                                      <FiCircle className="h-1.5 w-1.5" />
                                    )}
                                  </span>

                                  <div className="min-w-0 flex-1">
                                    <p
                                      className={`truncate text-sm font-medium leading-tight ${
                                        isActiveSection
                                          ? "text-brand-700 dark:text-brand-300"
                                          : ""
                                      }`}
                                    >
                                      {section.title}
                                    </p>
                                    {isActiveSection && section.summary && (
                                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                                        {section.summary}
                                      </p>
                                    )}
                                  </div>

                                  {/* Section number */}
                                  <span
                                    className={`shrink-0 text-[10px] font-medium ${
                                      isActiveSection
                                        ? "text-brand-500"
                                        : "text-slate-400 opacity-0 transition group-hover/item:opacity-100"
                                    }`}
                                  >
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </div>
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </nav>

        {/* Footer with quick stats */}
        {!isCollapsed && (
          <div className="border-t border-slate-200/50 p-4 dark:border-slate-700/50">
            <div className="rounded-lg bg-gradient-to-r from-brand-500/10 to-purple-500/10 p-3 dark:from-brand-500/20 dark:to-purple-500/20">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-600 dark:text-slate-300">
                  Reading Progress
                </span>
                <span className="font-bold text-brand-600 dark:text-brand-400">
                  {Math.round(
                    (readSections.size /
                      docs.categories.reduce(
                        (acc, c) => acc + c.sections.length,
                        0
                      )) *
                      100
                  )}
                  %
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand-500 to-purple-500 transition-all duration-500"
                  style={{
                    width: `${
                      (readSections.size /
                        docs.categories.reduce(
                          (acc, c) => acc + c.sections.length,
                          0
                        )) *
                      100
                    }%`,
                  }}
                />
              </div>
              <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
                {readSections.size} of{" "}
                {docs.categories.reduce((acc, c) => acc + c.sections.length, 0)}{" "}
                sections completed
              </p>
            </div>
          </div>
        )}
      </aside>
    </>
  );
};

export default Sidebar;
