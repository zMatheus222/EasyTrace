import pkg from 'pg';
const { Client } = pkg;

const client = new Client({
    user: 'local',
    host: '146.235.36.58',
    database: 'db',
    password: 'pass123',
    port: 5432,
});

async function sendToPg(flow_name, step_name, step_number, all_steps, status, description) {

    console.log(`[sendToPg] Called!`);

    try {

        if (client._ending) {
            await client.connect(); // Reconecta se necessário
        }

        if (client._connected === false) {
            console.error('[sendToPg] Conexão ao banco de dados não está ativa.');
            return false;
        }
        
        const res = await client.query(
            `INSERT INTO base.test_traces (flow_name, step_name, step_number, all_steps, status, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [flow_name, step_name, step_number, JSON.stringify(all_steps), status, description]
        );

        if (res.rows.length === 0) {
            console.error(`[sendToPg] Erro ao enviar o fluxo para o banco de dados.`);
            return false;
        }

        console.log(`[sendToPg] Sucesso ao enviar o fluxo ao banco de dados! id: ${res.rows[0].id}`);

        return true;
        
    } catch (error) {
        console.error('[sendToPg] Erro na consulta ao banco de dados:', error.message);
        return false;
    }
}

(async () => {
    try {
        await client.connect();
        console.log('[PostgreSQL] Conectado ao banco de dados com sucesso!');
    } catch (error) {
        console.error('[PostgreSQL] Erro ao conectar ao banco de dados:', error);
    }
})();

export { sendToPg };