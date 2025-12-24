import { useEffect, useState } from "react";
import { FiChevronRight, FiList } from "react-icons/fi";

const TableOfContents = ({ headings = [] }) => {
  const [activeId, setActiveId] = useState(headings[0]?.id ?? null);

  useEffect(() => {
    if (!headings.length) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      { rootMargin: "-40% 0px -50% 0px", threshold: [0, 0.25, 0.6] }
    );

    headings.forEach(({ id }) => {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    });

    return () => {
      headings.forEach(({ id }) => {
        const node = document.getElementById(id);
        if (node) observer.unobserve(node);
      });
    };
  }, [headings]);

  if (!headings.length) return null;

  // Calculate progress
  const activeIndex = headings.findIndex((h) => h.id === activeId);
  const progress =
    activeIndex >= 0 ? ((activeIndex + 1) / headings.length) * 100 : 0;

  return (
    <aside className="flex max-h-[70vh] flex-col overflow-hidden rounded-xl border border-slate-200/50 bg-white dark:border-slate-700/50 dark:bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200/50 bg-gradient-to-r from-slate-50 to-white px-4 py-3 dark:border-slate-700/50 dark:from-slate-800 dark:to-slate-900">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
            <FiList className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            On this page
          </span>
        </div>
        <span className="text-xs text-slate-400">
          {activeIndex + 1}/{headings.length}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-slate-100 dark:bg-slate-800">
        <div
          className="h-full bg-gradient-to-r from-brand-500 to-purple-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Links */}
      <nav className="relative flex-1 overflow-y-auto p-3 pr-2">
        {/* Vertical line */}
        <div className="absolute bottom-3 left-5 top-3 w-0.5 rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className="absolute left-0 top-0 w-full rounded-full bg-gradient-to-b from-brand-500 to-purple-500 transition-all duration-300"
            style={{ height: `${progress}%` }}
          />
        </div>

        <ul className="space-y-1">
          {headings.map((heading, index) => {
            const isActive = activeId === heading.id;
            const isPast = index <= activeIndex;
            const indentClass = heading.level === 3 ? "ml-4" : "ml-0";

            return (
              <li key={heading.id} className={indentClass}>
                <a
                  href={`#${heading.id}`}
                  className={`group relative flex items-center gap-2 rounded-lg py-2 pl-5 pr-2 text-sm transition-all ${
                    isActive
                      ? "bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                      : isPast
                      ? "text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/50"
                      : "text-slate-400 hover:bg-slate-50 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800/50 dark:hover:text-slate-400"
                  }`}
                >
                  {/* Dot indicator */}
                  <span
                    className={`absolute left-0 flex h-4 w-4 items-center justify-center rounded-full transition-all ${
                      isActive
                        ? "bg-brand-500 text-white ring-4 ring-brand-100 dark:ring-brand-900/50"
                        : isPast
                        ? "bg-brand-400 text-white"
                        : "bg-slate-300 dark:bg-slate-600"
                    }`}
                  >
                    {isActive && <FiChevronRight className="h-2.5 w-2.5" />}
                  </span>

                  <span
                    className={`flex-1 truncate ${
                      isActive ? "font-medium" : ""
                    }`}
                  >
                    {heading.text}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
};

export default TableOfContents;
