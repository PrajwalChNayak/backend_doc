import { useEffect, useMemo, useRef, useState } from "react";
import { FiSearch, FiX } from "react-icons/fi";
import { searchDocs } from "../utils/searchDocs";

const SearchBar = ({ docs, onNavigate, className = "" }) => {
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const wrapperRef = useRef(null);

  const results = useMemo(() => searchDocs(docs, query), [docs, query]);

  useEffect(() => {
    const handler = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleNavigate = (result) => {
    onNavigate?.(result);
    setQuery("");
    setIsFocused(false);
  };

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-4 py-2 shadow-sm ring-brand-400 transition focus-within:ring dark:border-slate-800 dark:bg-slate-900/80">
        <FiSearch className="text-slate-400" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setIsFocused(true)}
          placeholder="Search across docs"
          className="w-full bg-transparent text-sm font-medium text-slate-700 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Clear search"
          >
            <FiX />
          </button>
        )}
      </div>

      {isFocused && query && (
        <div className="absolute z-30 mt-2 w-full rounded-2xl border border-slate-100 bg-white/95 p-3 shadow-2xl dark:border-slate-800 dark:bg-slate-900/95">
          {results.length === 0 && (
            <p className="px-2 py-3 text-sm text-slate-500">
              No matches just yet. Try a broader keyword.
            </p>
          )}
          {results.length > 0 && (
            <ul className="max-h-72 space-y-2 overflow-y-auto">
              {results.map((result) => (
                <li key={result.key}>
                  <button
                    type="button"
                    onClick={() => handleNavigate(result)}
                    className="w-full rounded-xl px-3 py-2 text-left transition hover:bg-brand-50/70 dark:hover:bg-slate-800"
                  >
                    <p className="text-xs uppercase tracking-widest text-brand-500">
                      {result.categoryTitle}
                    </p>
                    <p className="font-semibold text-slate-900 dark:text-white">
                      {result.sectionTitle}
                    </p>
                    <p className="text-xs text-slate-500">{result.snippet}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchBar;
