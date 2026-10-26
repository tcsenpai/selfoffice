# AI modelleri ve ayarları

## Sağlayıcılar ve modeller

Modeller ve anahtarlar Ayarlar'da yapılandırılır (Giriş ekranının sol altındaki hesap satırı):

![Ayarlar penceresi](img/settings-general.png)

- **Claude (abonelik)** (varsayılan): yerel `claude` CLI oturumunuzu kullanır — bir kez `claude login` çalıştırın; modeller sonnet, opus, haiku; yalnızca metin, görsel yok. **Codex CLI** de desteklenir; Ollama veya LM Studio gibi yerel sunucular OpenAI uyumlu özel uç noktalar olarak çalışır.
- **Web araması ve medya**: web araması anahtarsız çalışır (ücretsiz zincir; anahtarlı sağlayıcılar isteğe bağlıdır). Görsel üretimi ve medya analizi, bir AI Media sağlayıcısı yapılandırılana kadar kapalı kalır.
- **Özel uç noktalar (BYOK)**: Ayarlar ▸ AI, her protokol için bir temel URL ve API anahtarı alır — OpenAI uyumlu, Anthropic, Gemini, DeepSeek, DashScope (qwen) ve daha fazlası. Anahtarlar bu makinedeki uygulama ayar dosyasında saklanır ve yalnızca istek başlıklarında gönderilir. Atlas Cloud yerleşik protokoller arasındadır.
- Her yetenek için farklı bir model seçilebilir: sohbet/üretim, görsel oluşturma, görsel analizi.
- **Bağlantı testi**: kaydetmeden önce uç noktanın erişilebilirliğini ve modellerin görünürlüğünü doğrulayın.
- Temel URL'ler yol ve sorgu dizesi taşıyabilir (ağ geçidi tarzı); uç nokta yolları doğru şekilde eklenir.

## CLI entegrasyonu (Codex sınıfı)

- Ayarlar yerel bir CLI program yolu kabul eder (ASCII dışı ev dizinleri ve ~ öneki çalışır; ~ otomatik olarak genişletilir); Modelleri algıla, CLI'ın kullanılabilir modellerini sorgular.
- Doğrulama yalnızca dosyanın varlığını denetler — karakter kümesi kısıtlaması yoktur.

## Değişiklikler ne zaman uygulanır

- Model ve uç nokta değişiklikleri hemen uygulanır; devam eden bir konuşma bir sonraki turuna kadar eski yapılandırmayı korur.
