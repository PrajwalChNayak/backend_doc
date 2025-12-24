import { useMemo } from "react";
import {
  FiAlertCircle,
  FiBookmark,
  FiCheckCircle,
  FiChevronRight,
  FiClock,
  FiCode,
  FiTerminal,
  FiZap,
} from "react-icons/fi";
import { parseContentBlocks } from "../utils/contentHelpers";
import CodeBlock from "./CodeBlock";

const ContentArea = ({
  category,
  section,
  headings,
  isBookmarked,
  onBookmarkToggle,
}) => {
  const blocks = useMemo(
    () => parseContentBlocks(section.content),
    [section.content]
  );
  const readingTime = useMemo(() => {
    const words = section.content?.split(/\s+/).length ?? 0;
    return Math.max(2, Math.round(words / 180));
  }, [section.content]);

  // Render markdown-style content with enhanced formatting
  const renderContent = (content) => {
    if (!content) return null;

    const lines = content.split("\n");
    const elements = [];
    let inList = false;
    let listItems = [];
    let inTable = false;
    let tableRows = [];
    let inCodeBlock = false;
    let codeLines = [];
    let codeLanguage = "";

    const flushList = () => {
      if (listItems.length > 0) {
        elements.push(
          <ul key={`list-${elements.length}`} className="my-4 space-y-2">
            {listItems.map((item, i) => (
              <li
                key={i}
                className="flex items-start gap-3 text-slate-600 dark:text-slate-300"
              >
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                <span
                  dangerouslySetInnerHTML={{ __html: formatInlineText(item) }}
                />
              </li>
            ))}
          </ul>
        );
        listItems = [];
      }
      inList = false;
    };

    const flushTable = () => {
      if (tableRows.length > 0) {
        const headers = tableRows[0];
        const body = tableRows.slice(2); // Skip header separator
        elements.push(
          <div
            key={`table-${elements.length}`}
            className="my-6 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-slate-100 to-slate-50 dark:from-slate-800 dark:to-slate-800/50">
                    {headers.map((cell, i) => (
                      <th
                        key={i}
                        className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200"
                      >
                        {cell.trim()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {body.map((row, i) => (
                    <tr
                      key={i}
                      className="transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          className="px-4 py-3 text-slate-600 dark:text-slate-300"
                        >
                          <span
                            dangerouslySetInnerHTML={{
                              __html: formatInlineText(cell.trim()),
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
        tableRows = [];
      }
      inTable = false;
    };

    const flushCodeBlock = () => {
      if (codeLines.length > 0) {
        elements.push(
          <div key={`code-${elements.length}`} className="my-6">
            <CodeBlock
              code={codeLines.join("\n")}
              language={codeLanguage || "bash"}
              title={codeLanguage ? `${codeLanguage} code` : "Code snippet"}
            />
          </div>
        );
        codeLines = [];
        codeLanguage = "";
      }
      inCodeBlock = false;
    };

    const formatInlineText = (text) => {
      return text
        .replace(
          /\*\*([^*]+)\*\*/g,
          '<strong class="font-semibold text-slate-900 dark:text-white">$1</strong>'
        )
        .replace(
          /`([^`]+)`/g,
          '<code class="rounded-md bg-slate-100 px-1.5 py-0.5 text-sm font-medium text-brand-600 dark:bg-slate-800 dark:text-brand-400">$1</code>'
        );
    };

    lines.forEach((line, index) => {
      const trimmedLine = line.trim();

      // Code block handling
      if (trimmedLine.startsWith("```")) {
        if (inCodeBlock) {
          flushCodeBlock();
        } else {
          flushList();
          flushTable();
          inCodeBlock = true;
          codeLanguage = trimmedLine.slice(3).trim();
        }
        return;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        return;
      }

      // Table handling
      if (trimmedLine.startsWith("|") && trimmedLine.endsWith("|")) {
        flushList();
        inTable = true;
        const cells = trimmedLine.slice(1, -1).split("|");
        if (!trimmedLine.includes("---")) {
          tableRows.push(cells);
        } else {
          tableRows.push(null); // Separator placeholder
        }
        return;
      } else if (inTable) {
        flushTable();
      }

      // List handling
      if (trimmedLine.startsWith("- ") || trimmedLine.startsWith("* ")) {
        if (!inList) {
          inList = true;
        }
        listItems.push(trimmedLine.slice(2));
        return;
      } else if (inList) {
        flushList();
      }

      // Headings
      if (trimmedLine.startsWith("## ")) {
        const text = trimmedLine.slice(3);
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        elements.push(
          <h2
            key={`h2-${index}`}
            id={id}
            className="group mt-12 mb-4 flex items-center gap-3 scroll-mt-28 text-2xl font-bold text-slate-900 dark:text-white"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-purple-600 text-white">
              <FiChevronRight className="h-4 w-4" />
            </span>
            {text}
          </h2>
        );
        return;
      }

      if (trimmedLine.startsWith("### ")) {
        const text = trimmedLine.slice(4);
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        elements.push(
          <h3
            key={`h3-${index}`}
            id={id}
            className="mt-8 mb-3 flex items-center gap-2 scroll-mt-28 text-lg font-semibold text-slate-800 dark:text-slate-200"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            {text}
          </h3>
        );
        return;
      }

      // Callout blocks (lines starting with special markers)
      if (
        trimmedLine.startsWith("**Important:**") ||
        trimmedLine.startsWith("**Note:**")
      ) {
        elements.push(
          <div
            key={`callout-${index}`}
            className="my-4 flex gap-3 rounded-xl border border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 p-4 dark:border-amber-800/50 dark:from-amber-900/20 dark:to-orange-900/20"
          >
            <FiAlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p
              className="text-sm text-amber-800 dark:text-amber-200"
              dangerouslySetInnerHTML={{
                __html: formatInlineText(trimmedLine),
              }}
            />
          </div>
        );
        return;
      }

      if (
        trimmedLine.startsWith("**Security Note:**") ||
        trimmedLine.startsWith("**Warning:**")
      ) {
        elements.push(
          <div
            key={`callout-${index}`}
            className="my-4 flex gap-3 rounded-xl border border-red-200 bg-gradient-to-r from-red-50 to-rose-50 p-4 dark:border-red-800/50 dark:from-red-900/20 dark:to-rose-900/20"
          >
            <FiAlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
            <p
              className="text-sm text-red-800 dark:text-red-200"
              dangerouslySetInnerHTML={{
                __html: formatInlineText(trimmedLine),
              }}
            />
          </div>
        );
        return;
      }

      if (
        trimmedLine.startsWith("**Tip:**") ||
        trimmedLine.startsWith("**Pro Tip:**")
      ) {
        elements.push(
          <div
            key={`callout-${index}`}
            className="my-4 flex gap-3 rounded-xl border border-green-200 bg-gradient-to-r from-green-50 to-emerald-50 p-4 dark:border-green-800/50 dark:from-green-900/20 dark:to-emerald-900/20"
          >
            <FiZap className="mt-0.5 h-5 w-5 shrink-0 text-green-600 dark:text-green-400" />
            <p
              className="text-sm text-green-800 dark:text-green-200"
              dangerouslySetInnerHTML={{
                __html: formatInlineText(trimmedLine),
              }}
            />
          </div>
        );
        return;
      }

      // Stats/highlight boxes
      if (trimmedLine.match(/^\d+%|^\d+\+|^\d+M\+|^\d+K\+/)) {
        elements.push(
          <div
            key={`stat-${index}`}
            className="my-4 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-brand-500/10 to-purple-500/10 px-4 py-2 text-sm font-medium text-brand-700 dark:text-brand-300"
          >
            <FiCheckCircle className="h-4 w-4" />
            <span
              dangerouslySetInnerHTML={{
                __html: formatInlineText(trimmedLine),
              }}
            />
          </div>
        );
        return;
      }

      // Empty lines
      if (!trimmedLine) {
        return;
      }

      // Regular paragraphs
      elements.push(
        <p
          key={`p-${index}`}
          className="my-4 leading-relaxed text-slate-600 dark:text-slate-300"
        >
          <span
            dangerouslySetInnerHTML={{ __html: formatInlineText(trimmedLine) }}
          />
        </p>
      );
    });

    // Flush any remaining content
    flushList();
    flushTable();
    flushCodeBlock();

    return elements;
  };

  return (
    <div className="relative">
      <article className="overflow-hidden rounded-2xl border border-slate-200/50 bg-white shadow-xl shadow-slate-200/50 dark:border-slate-700/50 dark:bg-slate-900 dark:shadow-none">
        {/* Hero header */}
        <header className="relative overflow-hidden border-b border-slate-200/50 bg-gradient-to-br from-slate-50 via-white to-brand-50/30 px-8 py-8 dark:border-slate-700/50 dark:from-slate-800 dark:via-slate-900 dark:to-brand-900/20">
          {/* Background decoration */}
          <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-gradient-to-br from-brand-500/10 to-purple-500/10 blur-3xl" />
          <div className="absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-gradient-to-br from-blue-500/10 to-cyan-500/10 blur-2xl" />

          <div className="relative flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="max-w-2xl">
              {/* Breadcrumb */}
              <div className="flex items-center gap-2 text-sm">
                <span className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                  <span className="text-lg">{category.icon}</span>
                  {category.title}
                </span>
                <FiChevronRight className="h-3 w-3 text-slate-400" />
                <span className="font-medium text-brand-600 dark:text-brand-400">
                  {section.title}
                </span>
              </div>

              {/* Title */}
              <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 dark:text-white md:text-4xl">
                {section.title}
              </h1>

              {/* Summary */}
              {section.summary && (
                <p className="mt-3 text-lg text-slate-600 dark:text-slate-300">
                  {section.summary}
                </p>
              )}

              {/* Meta info */}
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  <FiClock className="h-3.5 w-3.5" />
                  {readingTime} min read
                </span>
                <span className="flex items-center gap-2 rounded-full bg-green-100 px-3 py-1.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  <FiCheckCircle className="h-3.5 w-3.5" />
                  Updated
                </span>
                {section.codeExamples?.length > 0 && (
                  <span className="flex items-center gap-2 rounded-full bg-purple-100 px-3 py-1.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                    <FiCode className="h-3.5 w-3.5" />
                    {section.codeExamples.length} code example
                    {section.codeExamples.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>

            {/* Bookmark button */}
            <button
              type="button"
              onClick={onBookmarkToggle}
              className={`group/btn flex items-center gap-2 rounded-xl border-2 px-4 py-2.5 text-sm font-semibold transition-all ${
                isBookmarked
                  ? "border-brand-500 bg-brand-500 text-white shadow-lg shadow-brand-500/25"
                  : "border-slate-200 bg-white text-slate-600 hover:border-brand-500 hover:text-brand-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-brand-500"
              }`}
            >
              <FiBookmark
                className={`h-4 w-4 transition ${
                  isBookmarked ? "fill-current" : "group-hover/btn:scale-110"
                }`}
              />
              {isBookmarked ? "Saved" : "Save"}
            </button>
          </div>
        </header>

        {/* Main content */}
        <div className="px-8 py-8">
          <div className="prose prose-slate max-w-none dark:prose-invert">
            {renderContent(section.content)}
          </div>

          {/* Code examples section */}
          {section.codeExamples?.length > 0 && (
            <div className="mt-12 border-t border-slate-200 pt-8 dark:border-slate-700">
              <div className="mb-6 flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-slate-800 to-slate-900 text-white dark:from-slate-700 dark:to-slate-800">
                  <FiTerminal className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                    Code Examples
                  </h2>
                  <p className="text-sm text-slate-500">
                    Ready-to-use snippets you can copy
                  </p>
                </div>
              </div>

              <div className="space-y-6">
                {section.codeExamples.map((example, i) => (
                  <div key={example.title || i}>
                    <CodeBlock
                      code={example.code}
                      language={example.language}
                      title={example.title}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </article>
    </div>
  );
};

export default ContentArea;
