import express from 'express';
import cors from 'cors';
import { sendToPg } from './postgresql.js';

import * as fs from 'fs';

let test_configs = [];
try {
    test_configs = JSON.parse(fs.readFileSync('./tests.json', 'utf-8'));
} catch (error) {
    console.error(`[EasyTrace] Erro ao ler arquivo de configuração: ${error.message}`);
    process.exit(1);
}

const app = express();

app.use(express.json());
app.use(cors());

// Variável que armazena o estado dos testes
const testState = new Map();

// Inicializar o estado para cada teste
test_configs.forEach(testCfg => {
    console.log(`[EasyTrace] test_configs.forEach - testCfg: `, testCfg);
    testState.set(testCfg.flow_name, {
        received_calls: {},
        start_time: null,
        active: false,
        last_step: { step_name: null, step_number: null}
    });
});

console.log(`[testCfg] testState post forEach: `, testState);

// Reseta o estado do teste após conclusão
function resetTestState(flow_name) {
    testState.set(flow_name, {
        received_calls: {},
        start_time: null,
        active: false,
        last_step: { step_name: null, step_number: null }
    });
}

// Verifica timeout periodicamente
console.log(`[EasyTrace] SizeOf test_configs[]: ${test_configs.length}`);

setInterval(() => {
    test_configs.forEach(async (testCfg) => {

        try {

            const { flow_name, timeout, required_calls } = testCfg;
            const testStateToCompare = testState.get(flow_name);

            if (testStateToCompare.active && (Date.now() - testStateToCompare.start_time) > timeout) {

                const missingSteps = Object.keys(required_calls).filter(step => !testStateToCompare.received_calls[step]);

                console.log(`[EasyTrace] Verificando teste ${flow_name}: | testStateToCompare: `, testStateToCompare);

                let all_steps = testStateToCompare.received_calls;
                if (missingSteps.length > 0) {
                    console.log(`[EasyTrace] ⚠️ Passos ausentes: ${missingSteps.join(', ')}`); // Melhorar a leitura do log
                }

                console.log(`[EasyTrace] ❌ Teste "${flow_name}" falhou por timeout.`);

                // Recupera os últimos valores recebidos antes do timeout
                const { step_name, step_number } = testStateToCompare.last_step;

                const success = await sendToPg(flow_name, step_name, step_number, all_steps, "error", "Teste falhou por timeout");
                if (!success) {
                    console.error('[processTrace] Falha ao salvar o trace no banco de dados!');
                } else {
                    console.log('[processTrace] Trace salvo no banco de dados com sucesso!');
                }

                resetTestState(flow_name);
            }

        } catch (error) {
            console.error(`[EasyTrace] Erro no monitoramento de timeout: ${error}`);
        }
    });
}, 1000);

// Criar um endpoint que recebe traces
app.post('/api/receive_trace', async (req, res) => {
    
    console.log(`[EasyTrace] /api/receive_trace, req.body: `, req.body);

    const { flow_name, step_name, step_number, status, description } = req.body;
    if (!flow_name || !step_name || !step_number || !status || !description) {
        return res.status(400).send('[EasyTrace] Parâmetros inválidos ou incompletos.');
    }

    console.log(`[EasyTrace] [${new Date().toISOString()}] 🔍 Trace recebido: Teste "${step_name}", Passo "${step_number}", Status "${status}", Descrição: ${description}`);

    const foundedTestConfig = test_configs.find(test => test.flow_name === flow_name);
    if (!foundedTestConfig) {
        return res.status(400).send('[EasyTrace] Teste não encontrado.');
    }

    const testStateToCompare = testState.get(flow_name);
    if (!testStateToCompare.active) {
        testStateToCompare.start_time = Date.now();
        testStateToCompare.active = true;
    }

    // Armazenar ultimo passo recebido
    testStateToCompare.last_step = { step_name, step_number };
    testStateToCompare.received_calls[step_name] = status;

    const allStepsConcluded = Object.keys(foundedTestConfig.required_calls).every(
        step => {
            const expectedValue = foundedTestConfig.required_calls[step];
            const receivedValue = testStateToCompare.received_calls[step];
    
            // Se esperado e recebido são iguais (comparação direta)
            if (expectedValue === receivedValue) {
                return true;
            }
    
            // Se a string começa com 'REGEX:', trata como expressão regular
            if (expectedValue.startsWith("REGEX:")) {
                
                // Remove o prefixo e cria uma expressão regular
                const regexPattern = expectedValue.replace(/^REGEX:/, '');
                const regex = new RegExp(regexPattern);  // Converte para RegExp

                return regex.test(receivedValue);        // Aplica o teste regex
            }
    
            // Se não bate com o valor esperado
            return false;
        }
    );

    if (allStepsConcluded) {
        console.log(`[EasyTrace] ✅ Fluxo "${flow_name}" passou!`);
        resetTestState(flow_name);

        const success = await sendToPg(flow_name, step_name, step_number, testStateToCompare.received_calls, status, description);
        if (!success) {
            console.error('[processTrace] Falha ao salvar o trace no banco de dados!');
        } else {
            console.log('[processTrace] Trace salvo no banco de dados com sucesso!');
        }

        return res.status(200).send('[EasyTrace] Teste concluído com sucesso.');
    }

    res.status(200).send('[EasyTrace] Trace recebido e validado.');
});

app.listen(43500, () => {
    console.log('♦️ EasyTrace rodando na porta 43500');
});