import { useEffect, useRef, useState } from "react";
import { FiBookmark, FiGithub, FiMenu, FiMoon, FiSun } from "react-icons/fi";
import SearchBar from "./SearchBar";

const Header = ({
  theme,
  onThemeToggle,
  onToggleSidebar,
  docs,
  onNavigate,
  bookmarksMeta = [],
}) => {
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const bookmarkRef = useRef(null);

  useEffect(() => {
    const handleClick = (event) => {
      if (bookmarkRef.current && !bookmarkRef.current.contains(event.target)) {
        setBookmarksOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-white/70 backdrop-blur dark:bg-slate-950/70">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-4">
        <button
          type="button"
          className="rounded-2xl border border-slate-200 p-2 text-slate-500 shadow-sm transition hover:border-brand-400 lg:hidden"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
        >
          <FiMenu />
        </button>
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-teal-500 text-xl font-black text-white shadow-glow">
            &lt;/&gt;
          </div>
          <div>
            <p className="text-sm uppercase tracking-[0.4em] text-slate-400">
              Backend
            </p>
            <p className="text-lg font-semibold text-slate-900 dark:text-white">
              Documentation Hub
            </p>
          </div>
        </div>
        <SearchBar
          docs={docs}
          onNavigate={onNavigate}
          className="hidden flex-1 md:block"
        />
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            className="rounded-full border border-slate-200 bg-white p-2 text-lg text-slate-500 transition hover:border-brand-400 dark:border-slate-700 dark:bg-slate-900"
            onClick={onThemeToggle}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <FiSun /> : <FiMoon />}
          </button>
          <div className="relative" ref={bookmarkRef}>
            <button
              type="button"
              onClick={() => setBookmarksOpen((value) => !value)}
              className="relative rounded-full border border-slate-200 bg-white p-2 text-lg text-slate-500 transition hover:border-brand-400 dark:border-slate-700 dark:bg-slate-900"
              aria-label="Show bookmarks"
            >
              <FiBookmark />
              {bookmarksMeta.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
                  {bookmarksMeta.length}
                </span>
              )}
            </button>
            {bookmarksOpen && (
              <div className="absolute right-0 mt-3 w-72 rounded-2xl border border-white/10 bg-white/95 p-4 text-sm shadow-2xl dark:bg-slate-900">
                {bookmarksMeta.length === 0 && (
                  <p className="text-slate-500">No bookmarks yet.</p>
                )}
                {bookmarksMeta.length > 0 && (
                  <ul className="space-y-2">
                    {bookmarksMeta.map((bookmark) => (
                      <li key={bookmark.key}>
                        <button
                          type="button"
                          onClick={() => {
                            onNavigate(bookmark);
                            setBookmarksOpen(false);
                          }}
                          className="w-full rounded-xl px-3 py-2 text-left transition hover:bg-brand-50/70 dark:hover:bg-slate-800"
                        >
                          <p className="text-xs uppercase tracking-widest text-brand-500">
                            {bookmark.categoryTitle}
                          </p>
                          <p className="font-semibold text-slate-900 dark:text-white">
                            {bookmark.sectionTitle}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <a
            href="https://github.com/PrajwalChNayak"
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-slate-200 bg-white p-2 text-lg text-slate-500 transition hover:border-brand-400 dark:border-slate-700 dark:bg-slate-900"
            aria-label="GitHub"
          >
            <FiGithub />
          </a>
        </div>
      </div>
      <div className="px-4 pb-4 md:hidden">
        <SearchBar docs={docs} onNavigate={onNavigate} />
      </div>
    </header>
  );
};

export default Header;
