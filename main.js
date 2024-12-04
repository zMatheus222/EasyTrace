import express from 'express';
import cors from 'cors';
import { sendToPg } from './postgresql.js';

import * as fs from 'fs';

const app = express();

app.use(express.json());
app.use(cors());

let test_configs = [];
let testState = new Map();

async function loadTestsJson() {
    try {
        test_configs = JSON.parse(fs.readFileSync('./tests.json', 'utf-8'));

        console.log(`[EasyTrace] SizeOf test_configs[]: ${test_configs.length}`);

        if (!Array.isArray(test_configs) || test_configs.length === 0) {
            console.error('[EasyTrace] Configurações de teste inválidas.');
            process.exit(1);
        }
    } catch (error) {
        console.error(`[EasyTrace] Erro ao ler arquivo de configuração: ${error.message}`);
        process.exit(1);
    }
}

function StartConfigTests() {

    test_configs.forEach(testCfg => {
        if (!testCfg.required_calls || Object.keys(testCfg.required_calls).length === 0) {
            console.warn(`[Warning] required_calls está vazio ou ausente para o fluxo ${testCfg.flow_name}`);
        } else {
            Object.keys(testCfg.required_calls).forEach(step => {
                console.log(`[Debug] Configuração do passo "${step}":`, testCfg.required_calls[step]);
            });
        }
    });

    test_configs.forEach(testCfg => {

        const received_calls = {};

        Object.keys(testCfg.required_calls).forEach(step => {
            received_calls[step] = {
                expected_value: null,
                timeout: testCfg.required_calls[step].timeout
            };
        });

        testState.set(testCfg.flow_name, {
            received_calls,
            start_time: null,
            active: false,
            failed: false,
            missing_steps: [],
            last_step: { step_name: null, step_number: null }
        });
    
    });

}

// Reseta o estado do teste após conclusão
function resetTestState(flow_name) {
    const currentState = testState.get(flow_name);
    if (currentState) {
        currentState.start_time = null;
        currentState.active = false;
        currentState.missing_steps = [];
        currentState.last_step = { step_name: null, step_number: null };
        Object.keys(currentState.received_calls).forEach(step => {
            currentState.received_calls[step].expected_value = null;
        });
        testState.set(flow_name, currentState);
    } else {
        console.error(`[resetTestState] Error: Cannot reset state for non-existent flow "${flow_name}"`);
    }
}

// Função para lidar com a falha do teste
async function handleTestFailure(flow_name, reason) {
    const testStateToCompare = testState.get(flow_name);
    console.log(`[EasyTrace] ❌ Teste "${flow_name}" falhou: ${reason}`);

    testStateToCompare.failed = true;

    // Removendo timeout_id para envio ao banco de dados
    const cleanedState = JSON.parse(JSON.stringify(testStateToCompare, (key, value) => {
        if (key === 'timeout_id') return undefined; // Remove timeout_id to avoid circular reference
        return value;
    }));
    
    const success = await sendToPg(flow_name, testStateToCompare.last_step, cleanedState, "error", reason);
    if (!success) {
        console.error('[processTrace] Falha ao salvar o trace no banco de dados!');
    } else {
        console.log('[processTrace] Trace salvo no banco de dados com sucesso!');
    }

    resetTestState(flow_name);
}

// Função para verificar se todos os passos foram concluídos com sucesso
async function checkTestCompletion(flow_name) {
    const testStateToCompare = testState.get(flow_name);
    const allStepsCompleted = Object.values(testStateToCompare.received_calls).every(step => step.expected_value !== null);
    if (allStepsCompleted) {
        console.log(`[EasyTrace] ✅ Teste "${flow_name}" concluído com sucesso!`);
        
        const success = await sendToPg(flow_name, testStateToCompare.last_step, testStateToCompare.received_calls, "success", "Teste concluído com sucesso");
        if (!success) {
            console.error('[processTrace] Falha ao salvar o trace no banco de dados!');
        } else {
            console.log('[processTrace] Trace salvo no banco de dados com sucesso!');
        }
        resetTestState(flow_name);
    }
}

// Função para criar um timeout para um passo específico
function createStepTimeout(flow_name, step_name, timeout) {
    return setTimeout(async () => {
        const testStateToCompare = testState.get(flow_name);
        if (testStateToCompare && testStateToCompare.active && testStateToCompare.received_calls[step_name].expected_value === null) {
            console.log(`[EasyTrace] ❌ Timeout para o passo "${step_name}" do fluxo "${flow_name}"`);
            await handleTestFailure(flow_name, `Timeout no passo "${step_name}"`);
        }
    }, timeout);
}

async function processTrace(trace) {

    try { 

        const { flow_name, step_name, step_number, status } = trace;

        const testStateToCompare = testState.get(flow_name);
        if (!testStateToCompare) {
            console.error(`[EasyTrace] Erro: Estado do teste não encontrado para o fluxo "${flow_name}"`);
            return;
        }

        // Checando se o teste já chegou a falhar, se sim ignorar novos passos recebidos.
        if (testStateToCompare.failed) {
            console.log(`[EasyTrace] Ignorando passo "${step_name}" pois o fluxo "${flow_name}" já falhou.`);
            return;
        }

        // definindo o campod e last_step (ele serve para sabermos o ultimo passo recebido)
        testStateToCompare.last_step.step_name = step_name;
        testStateToCompare.last_step.step_number = step_number;

        // deixar o fluxo ativo caso não esteja e criar timeouts para cada step deste fluxo
        if (!testStateToCompare.active) {
            testStateToCompare.active = true;
            testStateToCompare.start_time = Date.now();
            
            // Crie timeouts para todos os passos esperados
            Object.entries(testStateToCompare.received_calls).forEach(([step, data]) => {
                data.timeout_id = createStepTimeout(flow_name, step, data.timeout);
            });
        }

        const testConfig = test_configs.find(test => test.flow_name === flow_name);
        if (!testConfig) {
            console.error(`[EasyTrace] Erro: Configuração não encontrada para o fluxo "${flow_name}"`);
            return;
        }

        // Verifica se o passo existe na configuração do teste
        if (!testConfig.required_calls[step_name]) {
            console.error(`[EasyTrace] Erro: Passo "${step_name}" não encontrado na configuração do fluxo "${flow_name}"`);
            return;
        }

        if (testStateToCompare.received_calls[step_name]) {
            
            // Cancela o timeout para este passo
            clearTimeout(testStateToCompare.received_calls[step_name].timeout_id);

            const expectedValue = testConfig.required_calls[step_name].expected_value;

            // Verifica se o valor recebido corresponde ao esperado
            let isValueValid = false;
            if (expectedValue.startsWith("REGEX:")) {
                const regex = new RegExp(expectedValue.replace(/^REGEX:/, ''));
                isValueValid = regex.test(status);
            } else {
                isValueValid = (status === expectedValue);
            }

            if (isValueValid) {
                testStateToCompare.received_calls[step_name].expected_value = status;
                console.log(`[EasyTrace] 🟢 Passo "${step_name}" do fluxo "${flow_name}" concluído com sucesso`);
                await checkTestCompletion(flow_name);
            } else {
                await handleTestFailure(flow_name, `Valor inválido para o passo "${step_name}"`);
            }
        } else {
            console.error(`[EasyTrace] Erro: Passo "${step_name}" não encontrado no estado do teste para o fluxo "${flow_name}"`);
        }

    } catch (error) {
        console.log(`[processTrace] Erro ao executar processTrace: `, error.message);
    }

}

async function main() {

    // Carregar testes no .json
    await loadTestsJson();

    // Configurar testState
    StartConfigTests();

};

main();

// Criar um endpoint que recebe traces
app.post('/api/receive_trace', async (req, res) => {

    const { flow_name, step_name, step_number, status, description } = req.body;
    if (!flow_name || !step_name || !step_number || !status || !description) {
        return res.status(400).send('[EasyTrace] Parâmetros inválidos ou incompletos.');
    }

    const testStateToCompare = testState.get(flow_name);
    if (testStateToCompare && testStateToCompare.failed) {
        return res.status(400).send(`[EasyTrace] O fluxo "${flow_name}" já falhou. Novos passos não serão processados.`);
    }

    console.log(`[EasyTrace] [${new Date().toISOString()}] 🔍 Trace recebido: Teste "${step_name}", Passo "${step_number}", Status "${status}", Descrição: ${description}`);

    await processTrace(req.body);

    res.status(200).send('[EasyTrace] Trace recebido e processado.');
});

app.listen(43500, () => {
    console.log('♦️ EasyTrace rodando na porta 43500');
});