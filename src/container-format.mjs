const APPLICATION_ID = 0x50475346; // "PGSF"
const FORMAT_VERSION = 1;

// Only accept our own format, or the exact schema used by the original POC.
// These checks run before any PRAGMA, schema or data mutation. Opening an
// unrelated SQLite database must never quietly turn it into a PG container.
export function assertContainerFormat(store) {
    const id = store.prepare('PRAGMA application_id').get().application_id;
    const version = store.prepare('PRAGMA user_version').get().user_version;
    const objects = store.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
    if (id !== 0 && id !== APPLICATION_ID) throw new Error('Not a pglite-singlefile-fs container');
    if (id === APPLICATION_ID && version !== FORMAT_VERSION) throw new Error('Unsupported pglite-singlefile-fs container format');
    if (id === 0 && version !== 0) throw new Error('Not a pglite-singlefile-fs container');
    if (!objects.length && id === 0) return;
    if (objects.length !== 2 || objects.some(o => o.type !== 'table' || !['nodes', 'chunks'].includes(o.name))) {
        throw new Error('Not a recognized pglite-singlefile-fs container schema');
    }
    const expected = {
        nodes: [['ino', 'INTEGER', 0, 1], ['path', 'TEXT', 0, 0], ['mode', 'INTEGER', 1, 0], ['size', 'INTEGER', 1, 0], ['mtime', 'INTEGER', 1, 0]],
        chunks: [['ino', 'INTEGER', 1, 1], ['page', 'INTEGER', 1, 2], ['data', 'BLOB', 1, 0]],
    };
    for (const [table, columns] of Object.entries(expected)) {
        const actual = store.prepare(`PRAGMA table_info(${table})`).all();
        if (actual.length !== columns.length || actual.some((c, i) =>
            c.name !== columns[i][0] || c.type.toUpperCase() !== columns[i][1] || c.notnull !== columns[i][2] || c.pk !== columns[i][3])) {
            throw new Error('Not a recognized pglite-singlefile-fs container schema');
        }
        const size = actual.find(c => c.name === 'size');
        if (size && String(size.dflt_value) !== '0') throw new Error('Not a recognized pglite-singlefile-fs container schema');
    }
    const indexes = store.prepare('PRAGMA index_list(nodes)').all();
    const uniquePath = indexes.some(index => index.unique === 1 && index.partial === 0 && (() => {
        const name = index.name.replaceAll("'", "''");
        const columns = store.prepare(`PRAGMA index_info('${name}')`).all();
        return columns.length === 1 && columns[0].name === 'path';
    })());
    if (!uniquePath) throw new Error('Not a recognized pglite-singlefile-fs container schema');
    if (id === 0) {
        const root = store.prepare("SELECT ino,mode,size FROM nodes WHERE path='/'").get();
        const unnamed = store.prepare('SELECT ino FROM nodes WHERE path IS NULL LIMIT 1').get();
        // The old POC always created this root and never stored detached/null
        // names. Matching column names alone is not enough to identify it.
        if (!root || root.ino !== 1 || root.mode !== 16832 || root.size !== 0 || unnamed) {
            throw new Error('Not a recognized legacy pglite-singlefile-fs container root');
        }
        // Reject schema variants containing additional constraints or generated
        // expressions that happen to share the same column information.
        for (const object of objects) {
            const normalized = object.sql.replace(/[\s;]/g, '').toUpperCase();
            const nodes = 'CREATETABLENODES(INOINTEGERPRIMARYKEY,PATHTEXTUNIQUE,MODEINTEGERNOTNULL,SIZEINTEGERNOTNULLDEFAULT0,MTIMEINTEGERNOTNULL)';
            const chunks = 'CREATETABLECHUNKS(INOINTEGERNOTNULL,PAGEINTEGERNOTNULL,DATABLOBNOTNULL,PRIMARYKEY(INO,PAGE))';
            if (object.name === 'nodes' ? normalized !== nodes : normalized !== chunks && normalized !== chunks + 'WITHOUTROWID') {
                throw new Error('Not a recognized legacy pglite-singlefile-fs container schema');
            }
        }
    }
}

export function markContainerFormat(store) {
    const id = store.prepare('PRAGMA application_id').get().application_id;
    const version = store.prepare('PRAGMA user_version').get().user_version;
    if (id === APPLICATION_ID && version === FORMAT_VERSION) return;
    // Migration metadata is one atomic header update. A crash must not leave
    // an identified legacy image carrying an unsupported half-written version.
    store.exec(`BEGIN; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${FORMAT_VERSION}; COMMIT;`);
}
