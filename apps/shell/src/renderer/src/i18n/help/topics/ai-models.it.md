# Modelli IA e impostazioni

## Provider e modelli

Modelli e chiavi si configurano nelle impostazioni (la riga dell'account in basso a sinistra in Home):

![La finestra Impostazioni](img/settings-general.png)

- **Claude (abbonamento)** (predefinito): usa il tuo login locale della CLI `claude` — esegui `claude login` una volta; modelli sonnet, opus, haiku; solo testo, niente immagini. È supportata anche **Codex CLI**, e server locali come Ollama o LM Studio funzionano come endpoint personalizzati compatibili con OpenAI.
- **Ricerca web e media**: la ricerca web funziona senza chiave (catena gratuita; i provider con chiave sono facoltativi). Generazione di immagini e analisi dei media restano disattivate finché non configuri un provider AI Media.
- **Endpoint personalizzati (BYOK)**: Impostazioni ▸ IA accetta un URL di base e una chiave API per ogni protocollo — compatibile con OpenAI, Anthropic, Gemini, DeepSeek, DashScope (qwen) e altro. Le chiavi sono memorizzate nel file delle impostazioni dell'app su questa macchina e inviate solo nelle intestazioni delle richieste. Atlas Cloud figura tra i protocolli integrati.
- Puoi scegliere un modello diverso per ciascuna capacità: chat/generazione, generazione di immagini, analisi delle immagini.
- **Prova connessione**: verifica che l'endpoint sia raggiungibile e che il modello sia visibile prima di salvare.
- Gli URL di base possono contenere un percorso e una stringa di query (stile gateway); i percorsi degli endpoint vengono aggiunti correttamente.

## Integrazione con la CLI (classe Codex)

- Le impostazioni accettano il percorso di un programma CLI locale (le directory home non ASCII e il prefisso ~ funzionano; ~ viene espanso automaticamente); Rileva modelli interroga la CLI sui modelli disponibili.
- La convalida verifica solo l'esistenza — nessuna restrizione sul set di caratteri.

## Quando hanno effetto le modifiche

- Le modifiche a modello ed endpoint hanno effetto immediato; una conversazione in corso mantiene la vecchia configurazione fino al turno successivo.
