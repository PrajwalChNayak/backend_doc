import { Link } from "react-router-dom";

const BreadcrumbNav = ({ items = [] }) => {
  if (!items.length) return null;

  return (
    <nav
      className="text-sm text-slate-500 dark:text-slate-300"
      aria-label="Breadcrumb"
    >
      <ol className="flex flex-wrap items-center gap-2">
        {items.map((item, index) => (
          <li key={item.href ?? item.label} className="flex items-center gap-2">
            {index > 0 && <span className="text-slate-400">/</span>}
            {item.href ? (
              <Link
                to={item.href}
                className="font-medium text-slate-600 hover:text-brand-500 dark:text-slate-200"
              >
                {item.label}
              </Link>
            ) : (
              <span className="font-semibold text-slate-900 dark:text-white">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
};

export default BreadcrumbNav;
