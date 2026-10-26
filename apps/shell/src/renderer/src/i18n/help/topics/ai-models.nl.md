# AI-modellen en instellingen

## Providers en modellen

Modellen en sleutels stel je in Instellingen in (de accountregel linksonder op Start):

![Het venster Instellingen](img/settings-general.png)

- **Claude (abonnement)** (standaard): gebruikt je lokale `claude`-CLI-login — voer één keer `claude login` uit; modellen sonnet, opus, haiku; alleen tekst, geen afbeeldingen. **Codex CLI** wordt ook ondersteund, en lokale servers zoals Ollama of LM Studio werken als eigen OpenAI-compatibele eindpunten.
- **Webzoeken en media**: webzoeken werkt zonder sleutel (gratis keten; providers met sleutel zijn optioneel). Afbeeldingen genereren en media-analyse blijven uit tot een AI Media-provider is ingesteld.
- **Eigen eindpunten (BYOK)**: Instellingen ▸ AI-model vraagt een basis-URL en een API-sleutel per protocol — OpenAI-compatibel, Anthropic, Gemini, DeepSeek, DashScope (qwen) en meer. Sleutels worden opgeslagen in het instellingenbestand van de app op deze machine en alleen in aanvraagheaders verzonden. Atlas Cloud behoort tot de ingebouwde protocollen.
- Per functie kun je een ander model kiezen: chat/genereren, afbeeldingen genereren, afbeeldingsanalyse.
- **Verbinding testen**: controleert vóór het opslaan of het eindpunt bereikbaar is en het model zichtbaar is.
- Basis-URL's mogen een pad en een querystring bevatten (gateway-stijl); eindpuntpaden worden correct toegevoegd.

## Integratie met de opdrachtregel (Codex-klasse)

- Instellingen accepteren het pad naar een lokaal CLI-programma (niet-ASCII-thuismappen en een ~-voorvoegsel werken; ~ wordt automatisch uitgebreid); Detecteer modellen vraagt de CLI welke modellen beschikbaar zijn.
- De validatie controleert alleen of het pad bestaat — geen beperkingen op de tekenset.

## Wanneer wijzigingen ingaan

- Wijzigingen aan model en eindpunt gaan meteen in; een lopend gesprek houdt de oude configuratie aan tot de volgende beurt.
