import { useMemo } from "react";
import { Navigate, useParams } from "react-router-dom";
import BreadcrumbNav from "../components/BreadcrumbNav";
import ContentArea from "../components/ContentArea";
import { extractHeadings } from "../utils/contentHelpers";
import { bookmarkKey } from "../utils/searchDocs";

const Documentation = ({ docs, bookmarks, onBookmarkToggle }) => {
  const { categoryId, sectionId } = useParams();
  const defaultCategory = docs.categories[0];
  const defaultSection = defaultCategory.sections[0];

  const category =
    docs.categories.find((entry) => entry.id === categoryId) ?? defaultCategory;
  const section =
    category.sections.find((entry) => entry.id === sectionId) ??
    category.sections[0] ??
    defaultSection;

  if (!category || !section) {
    return (
      <Navigate to={`/${defaultCategory.id}/${defaultSection.id}`} replace />
    );
  }

  const headings = useMemo(
    () => extractHeadings(section.content),
    [section.content]
  );
  const currentKey = bookmarkKey(category.id, section.id);
  const isBookmarked = bookmarks.includes(currentKey);

  const categoryLanding = category.sections[0] ?? section;

  const breadcrumbs = [
    { label: "Docs", href: `/${defaultCategory.id}/${defaultSection.id}` },
    categoryLanding
      ? { label: category.title, href: `/${category.id}/${categoryLanding.id}` }
      : null,
    { label: section.title },
  ].filter(Boolean);

  return (
    <div className="space-y-6 fade-in">
      <BreadcrumbNav items={breadcrumbs} />
      <ContentArea
        category={category}
        section={section}
        headings={headings}
        isBookmarked={isBookmarked}
        onBookmarkToggle={() => onBookmarkToggle(currentKey)}
      />
    </div>
  );
};

export default Documentation;
