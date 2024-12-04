import express from 'express';
import cors from 'cors';
import { sendToPg } from './postgresql.js';

import * as fs from 'fs';

let test_configs = [];
try {
    test_configs = JSON.parse(fs.readFileSync('./tests.json', 'utf-8'));
    if (!Array.isArray(test_configs) || test_configs.length === 0) {
        console.error('[EasyTrace] Configurações de teste inválidas.');
        process.exit(1);
    }
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
        missing_steps: [],
        last_step: { step_name: null, step_number: null }
    });

});

test_configs.forEach(testCfg => {
    if (!testCfg.required_calls || Object.keys(testCfg.required_calls).length === 0) {
        console.warn(`[Warning] required_calls está vazio ou ausente para o fluxo ${testCfg.flow_name}`);
    } else {
        Object.keys(testCfg.required_calls).forEach(step => {
            console.log(`[Debug] Configuração do passo "${step}":`, testCfg.required_calls[step]);
        });
    }
});

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
        console.error(`[Error] Cannot reset state for non-existent flow "${flow_name}"`);
    }
}

// Verifica timeout periodicamente
console.log(`[EasyTrace] SizeOf test_configs[]: ${test_configs.length}`);

setInterval(() => {
    test_configs.forEach(async (testCfg) => {

        try {

            const { flow_name, required_calls } = testCfg;
            const testStateToCompare = testState.get(flow_name);

            if (testStateToCompare.active) {
                
                console.log(`[EasyTrace] Verificando teste ${flow_name}: | testStateToCompare: `, testStateToCompare);

                // comparar timeout recebido externo com o definido na configuração do teste localmente.
                Object.keys(required_calls).filter(step => {
                    // console.log(`[c] step: `, step);
                    // console.log(`[c] testStateToCompare.received_calls[step]: `, testStateToCompare.received_calls[step]);
                    // console.log(`[c] testStateToCompare.received_calls[step].expected_value: `, testStateToCompare.received_calls[step].expected_value);
                    // console.log(`[c] testStateToCompare.received_calls[step].expected_value == null: `, testStateToCompare.received_calls[step].expected_value == null);
                    if (testStateToCompare.received_calls[step].expected_value == null) {
                        testStateToCompare.missing_steps.push(step);
                    }
                });

                console.log(`[EasyTrace] testStateToCompare.missing_steps: `, testStateToCompare.missing_steps);

                let all_steps = testStateToCompare.received_calls;

                //console.log(`[EasyTrace] testStateToCompare.missing_steps.length: ${testStateToCompare.missing_steps.length}`);
                //console.log(`[EasyTrace] time comparation: ${Date.now() - testStateToCompare.start_time > required_calls[testStateToCompare.last_step.step_name].timeout}`);
                
                if (testStateToCompare.missing_steps.length > 0 && Date.now() - testStateToCompare.start_time > required_calls[testStateToCompare.last_step.step_name].timeout) {
                    console.log(`[EasyTrace] ⚠️ Passos ausentes: ${testStateToCompare.missing_steps.join(', ')}`); // Melhorar a leitura do log
                    
                    console.log(`[EasyTrace] ❌ Teste "${flow_name}" falhou por timeout.`);
                    
                    // Recupera os últimos valores recebidos antes do timeout
                    const { step_name, step_number } = testStateToCompare.last_step;
                    
                    const success = await sendToPg(flow_name, step_name, step_number, all_steps, "error", "Teste falhou por timeout");
                    if (!success) {
                        console.error('[processTrace] Falha ao salvar o trace no banco de dados!', { flow_name, step_name, step_number });
                    } else {
                        console.log('[processTrace] Trace salvo no banco de dados com sucesso!');
                    }
                    
                    resetTestState(flow_name);
                }
            }

        } catch (error) {
            console.error(`[EasyTrace] Erro no monitoramento de timeout: ${error}`);
        }
    });
}, 500);

// Criar um endpoint que recebe traces
app.post('/api/receive_trace', async (req, res) => {
    
    console.log(`[EasyTrace] /api/receive_trace, req.body: `, req.body);

    const { flow_name, step_name, step_number, status, description } = req.body;
    if (!flow_name || !step_name || !step_number || !status || !description) {
        return res.status(400).send('[EasyTrace] Parâmetros inválidos ou incompletos.');
    }

    console.log(`[EasyTrace] [${new Date().toISOString()}] 🔍 Trace recebido: Teste "${step_name}", Passo "${step_number}", Status "${status}", Descrição: ${description}`);

    if (!testState.has(flow_name)) {
        console.error(`[Error] O estado do fluxo "${flow_name}" não foi encontrado.`);
        return res.status(400).send({ error: `Fluxo "${flow_name}" não inicializado.` });
    }

    const foundedTestConfig = test_configs.find(test => test.flow_name === flow_name);
    if (!foundedTestConfig) {
        return res.status(400).send('[EasyTrace] Teste não encontrado.');
    }

    const testStateToCompare = testState.get(flow_name);
    if (!testStateToCompare) {
        console.error(`[Error] Test state for flow "${flow_name}" not found.`);
        return res.status(400).send(`[EasyTrace] Test state for flow "${flow_name}" not found.`);
    }

    if (!testStateToCompare.received_calls) {
        console.error(`[Error] received_calls for flow "${flow_name}" is undefined.`);
        return res.status(400).send(`[EasyTrace] received_calls for flow "${flow_name}" is undefined.`);
    }

    if (!testStateToCompare.received_calls.hasOwnProperty(step_name)) {
        console.warn(`[Warning] The step "${step_name}" was not configured in the flow "${flow_name}".`);
    }

    if (!testStateToCompare.active) {
        testStateToCompare.start_time = Date.now();
        testStateToCompare.active = true;
    }

    console.log(`[EasyTrace] Armazenando ultimo passo recebido, step_name: ${step_name}, step_number: ${step_number}, status: ${status}`);

    // Armazenar ultimo passo recebido
    testStateToCompare.last_step = { step_name, step_number };

    console.log(`[EasyTrace] Current test state for "${flow_name}":`, JSON.stringify(testStateToCompare, null, 2));
    
    if (testStateToCompare.received_calls[step_name]) {
        testStateToCompare.received_calls[step_name].expected_value = status;
    } else {
        console.error(`[EasyTrace] Erro: O passo "${step_name}" não foi encontrado em received_calls`);
        return res.status(400).send('[EasyTrace] Passo não encontrado no estado do teste.');
    }

    console.log(`[EasyTrace] Itens Armazenados: `, testStateToCompare);

    const allStepsConcluded = Object.keys(foundedTestConfig.required_calls).every(step => {
        
            const expectedValue = foundedTestConfig.required_calls[step].expected_value;
            const receivedValue = testStateToCompare.received_calls[step].expected_value;
    
            if (expectedValue == null || receivedValue == null) {
                testStateToCompare.missing_steps.push(step);
                return false; // ou algum outro valor padrão
            }
    
            // Se a string começa com 'REGEX:', trata como expressão regular
            if (expectedValue && expectedValue.startsWith("REGEX:")) {
                
                // Remove o prefixo e cria uma expressão regular
                const regexPattern = expectedValue.replace(/^REGEX:/, '');
                const regex = new RegExp(regexPattern);  // Converte para RegExp

                // faz a comparação com regex, se for false adiciona a missing steps e retorna false
                if (!regex.test(receivedValue)) {
                    testStateToCompare.missing_steps.push(step);
                    return false;
                }

                return true;
            }

            // parecido com a cima, só que para comparação sem regex
            if (expectedValue !== receivedValue) {
                testStateToCompare.missing_steps.push(step);
                return false;
            }

            return true;

        }
    );

    if (allStepsConcluded) {
        console.log(`[EasyTrace] ✅ Fluxo "${flow_name}" concluído com sucesso!`);
        
        const success = await sendToPg(flow_name, step_name, step_number, testStateToCompare.received_calls, status, description);
        if (!success) {
            console.error('[processTrace] Falha ao salvar o trace no banco de dados!');
        } else {
            console.log('[processTrace] Trace salvo no banco de dados com sucesso!');
        }
        
        resetTestState(flow_name);
        return res.status(200).send('[EasyTrace] Teste concluído com sucesso.');
    }

    
    res.status(200).send('[EasyTrace] Trace recebido e validado.');
});

app.listen(43500, () => {
    console.log('♦️ EasyTrace rodando na porta 43500');
});