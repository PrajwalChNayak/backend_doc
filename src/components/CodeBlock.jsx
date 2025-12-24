import { Highlight, themes } from "prism-react-renderer";
import { useState } from "react";
import {
  FiCheck,
  FiCode,
  FiCopy,
  FiFileText,
  FiTerminal,
} from "react-icons/fi";

const languageIcons = {
  bash: FiTerminal,
  shell: FiTerminal,
  sh: FiTerminal,
  yaml: FiFileText,
  yml: FiFileText,
  json: FiFileText,
  javascript: FiCode,
  js: FiCode,
  typescript: FiCode,
  ts: FiCode,
  python: FiCode,
  go: FiCode,
  java: FiCode,
};

const languageColors = {
  bash: "from-green-500 to-emerald-600",
  shell: "from-green-500 to-emerald-600",
  sh: "from-green-500 to-emerald-600",
  yaml: "from-purple-500 to-violet-600",
  yml: "from-purple-500 to-violet-600",
  json: "from-amber-500 to-orange-600",
  javascript: "from-yellow-500 to-amber-600",
  js: "from-yellow-500 to-amber-600",
  typescript: "from-blue-500 to-indigo-600",
  ts: "from-blue-500 to-indigo-600",
  python: "from-blue-500 to-cyan-600",
  go: "from-cyan-500 to-teal-600",
  java: "from-red-500 to-orange-600",
};

const CodeBlock = ({ code = "", language = "bash", title }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.warn("Clipboard copy failed", error);
    }
  };

  const Icon = languageIcons[language] || FiCode;
  const gradientColor =
    languageColors[language] || "from-slate-500 to-slate-600";
  const lineCount = code.trim().split("\n").length;

  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-900 shadow-2xl shadow-slate-900/20 dark:border-slate-700">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 bg-gradient-to-r from-slate-800 to-slate-850 px-4 py-3">
        <div className="flex items-center gap-3">
          {/* Window dots */}
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-red-500/80" />
            <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
            <span className="h-3 w-3 rounded-full bg-green-500/80" />
          </div>

          {/* Language badge */}
          <div className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br ${gradientColor} text-white shadow-lg`}
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="text-sm font-medium text-slate-300">
              {title || language}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Line count */}
          <span className="hidden text-xs text-slate-500 sm:block">
            {lineCount} line{lineCount !== 1 ? "s" : ""}
          </span>

          {/* Copy button */}
          <button
            type="button"
            onClick={handleCopy}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
              copied
                ? "bg-green-500/20 text-green-400"
                : "bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white"
            }`}
          >
            {copied ? (
              <>
                <FiCheck className="h-3.5 w-3.5" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <FiCopy className="h-3.5 w-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code content */}
      <Highlight code={code.trim()} language={language} theme={themes.nightOwl}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <div className="relative overflow-auto">
            <pre
              className={`${className} m-0 py-4 text-sm leading-relaxed`}
              style={{ ...style, background: "transparent" }}
            >
              <code className="grid">
                {tokens.map((line, i) => {
                  const lineProps = getLineProps({ line, key: i });
                  return (
                    <div
                      key={i}
                      {...lineProps}
                      className={`${
                        lineProps.className || ""
                      } group/line flex border-l-2 border-transparent px-4 transition hover:border-brand-500 hover:bg-slate-800/50`}
                    >
                      {/* Line number */}
                      <span className="mr-4 inline-block w-8 select-none text-right text-slate-600 group-hover/line:text-slate-400">
                        {i + 1}
                      </span>
                      {/* Line content */}
                      <span className="flex-1">
                        {line.map((token, key) => (
                          <span key={key} {...getTokenProps({ token, key })} />
                        ))}
                      </span>
                    </div>
                  );
                })}
              </code>
            </pre>
          </div>
        )}
      </Highlight>

      {/* Bottom fade for long code */}
      {lineCount > 10 && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-slate-900 to-transparent" />
      )}
    </div>
  );
};

export default CodeBlock;
