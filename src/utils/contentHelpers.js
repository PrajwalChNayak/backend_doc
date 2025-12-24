export const slugifyHeading = (value = '') =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, '-')

export const parseContentBlocks = (raw = '') => {
    const lines = raw.split('\n')
    const blocks = []
    let currentList = []

    const flushList = () => {
        if (currentList.length) {
            blocks.push({ type: 'list', items: currentList })
            currentList = []
        }
    }

    lines.forEach((line) => {
        const trimmed = line.trim()
        if (!trimmed) {
            flushList()
            return
        }

        if (trimmed.startsWith('### ')) {
            flushList()
            const text = trimmed.replace('### ', '')
            blocks.push({ type: 'heading', level: 3, text, id: slugifyHeading(text) })
            return
        }

        if (trimmed.startsWith('## ')) {
            flushList()
            const text = trimmed.replace('## ', '')
            blocks.push({ type: 'heading', level: 2, text, id: slugifyHeading(text) })
            return
        }

        if (trimmed.startsWith('- ')) {
            currentList.push(trimmed.replace('- ', ''))
            return
        }

        flushList()
        blocks.push({ type: 'paragraph', text: trimmed })
    })

    flushList()
    return blocks
}

export const extractHeadings = (raw = '') =>
    parseContentBlocks(raw)
        .filter((block) => block.type === 'heading')
        .map(({ id, text, level }) => ({ id, text, level }))
