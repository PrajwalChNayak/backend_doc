const normalize = (value = '') => value.toLowerCase()

const makeKey = (categoryId, sectionId) => `${categoryId}:${sectionId}`

const buildSnippet = (content, query) => {
    const lower = normalize(content)
    const index = lower.indexOf(normalize(query))
    if (index === -1) {
        return content.slice(0, 120) + (content.length > 120 ? '...' : '')
    }
    const start = Math.max(0, index - 40)
    const end = Math.min(content.length, index + 80)
    return `${content.slice(start, end)}...`
}

export const searchDocs = (docs, query) => {
    if (!query || !query.trim()) return []
    const q = normalize(query)
    const matches = []

    docs.categories.forEach((category) => {
        category.sections.forEach((section) => {
            const haystack = [section.title, section.summary, section.content]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()

            if (haystack.includes(q)) {
                matches.push({
                    key: makeKey(category.id, section.id),
                    categoryId: category.id,
                    sectionId: section.id,
                    categoryTitle: category.title,
                    sectionTitle: section.title,
                    snippet: buildSnippet(section.content, query),
                })
                return
            }

            const codeHit = section.codeExamples?.some((example) => example.code.toLowerCase().includes(q))
            if (codeHit) {
                matches.push({
                    key: makeKey(category.id, section.id),
                    categoryId: category.id,
                    sectionId: section.id,
                    categoryTitle: category.title,
                    sectionTitle: section.title,
                    snippet: 'Matched inside a code example',
                })
            }
        })
    })

    return matches.slice(0, 6)
}

export const bookmarkKey = makeKey
