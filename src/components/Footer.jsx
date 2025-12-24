import { FiGithub, FiLinkedin, FiTwitter } from "react-icons/fi";

const Footer = () => (
  <footer className="border-t border-white/10 bg-white/70 py-8 text-sm text-slate-500 backdrop-blur dark:bg-slate-950/70">
    <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-center md:flex-row md:text-left">
      <p>
        © {new Date().getFullYear()} Backend Atlas. Built with React, Vite, and
        Tailwind.
      </p>
      <div className="flex items-center gap-3 text-lg">
        <a
          href="https://github.com/PrajwalChNayak"
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-brand-400 dark:border-slate-700 dark:text-slate-300"
        >
          <FiGithub />
        </a>
        <a
          href="https://twitter.com"
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-brand-400 dark:border-slate-700 dark:text-slate-300"
        >
          <FiTwitter />
        </a>
        <a
          href="https://linkedin.com"
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-brand-400 dark:border-slate-700 dark:text-slate-300"
        >
          <FiLinkedin />
        </a>
      </div>
    </div>
  </footer>
);

export default Footer;
