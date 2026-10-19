export class ImportState {
    constructor(sql) {
        this.sql = sql;
        sql.exec('CREATE TABLE IF NOT EXISTS _pglite_control (key TEXT PRIMARY KEY) WITHOUT ROWID');
    }
    hasStarted() {
        return this.sql.prepare("SELECT key FROM _pglite_control WHERE key = 'started'").get() !== undefined;
    }
    markStarted() {
        this.sql.exec("INSERT OR IGNORE INTO _pglite_control VALUES ('started')");
    }
}
