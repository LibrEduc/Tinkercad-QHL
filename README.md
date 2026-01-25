# Tinkercad Desktop

Application desktop Electron qui intègre Tinkercad (Autodesk) avec des fonctionnalités Arduino pour compiler et téléverser du code directement depuis l'interface.

![Capture d'écran](capture.png)

## 📋 Description

Tinkercad Desktop est une application qui permet d'utiliser Tinkercad dans une fenêtre desktop native, avec des fonctionnalités supplémentaires pour travailler avec Arduino. L'application intègre Arduino CLI pour compiler et téléverser vos sketches directement depuis l'éditeur de code de Tinkercad.

## ✨ Fonctionnalités

- **Interface Tinkercad intégrée** : Accès complet à Tinkercad Circuits dans une application desktop
- **Compilation et téléversement Arduino** : Compile et téléverse votre code Arduino directement depuis Tinkercad
- **Détection automatique des cartes** : Détecte automatiquement les cartes Arduino connectées
- **Copie de code** : Copie facilement le code depuis l'éditeur Tinkercad vers le presse-papier (raccourci : `Ctrl+Alt+C`)
- **Installation de bibliothèques** : Installez des bibliothèques Arduino directement depuis l'application
- **Multilingue** : Support du français et de l'anglais avec détection automatique de la langue du système
- **Installation du compilateur** : Installation automatique du compilateur Arduino AVR si nécessaire

## 📖 Utilisation

### Première utilisation

1. Lancez l'application
2. Connectez votre carte Arduino Uno à votre ordinateur
3. L'application détectera automatiquement la carte dans le menu "Lister les cartes disponibles"
4. Sélectionnez le port COM correspondant à votre carte

### Compiler et téléverser du code

1. Ouvrez Tinkercad Circuits et créez votre circuit (sinon un message d'erreur apparaîtra)
2. Écrivez ou modifiez votre programme en blocs ou code Arduino
3. Allez dans le menu **Arduino > Téléverser le code**
4. Le code sera automatiquement compilé puis téléversé sur votre carte

### Copier le code

- Utilisez le raccourci `Ctrl+Alt+C` ou allez dans **Fichier > Copier le code**
- Le code sera copié dans le presse-papier

### Installer une bibliothèque

1. Allez dans **Arduino > Installer une bibliothèque**
2. Entrez le nom de la bibliothèque (ex: `Servo`, `LiquidCrystal`, etc.)
3. La bibliothèque sera installée via Arduino CLI

### Installer le compilateur Arduino

Si c'est la première fois que vous utilisez l'application :
1. Allez dans **Arduino > Installer le compilateur Arduino**
2. Attendez la fin de l'installation

### Changer la langue

1. Allez dans **Fichier > Langue**
2. Sélectionnez **English** ou **Français**

## 📝 Notes importantes

- L'application nécessite une connexion Internet pour accéder à Tinkercad
- Les bibliothèques installées sont stockées dans le dossier de configuration d'Arduino CLI

## 👤 Auteur

**Sébastien Canet**

## 📄 Licence

Ce projet est sous licence CC0-1.0 (Creative Commons Zero).

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à ouvrir une issue ou une pull request.

## 🔗 Liens utiles

- [Tinkercad](https://www.tinkercad.com)
- [Documentation Tinkercad Circuits](https://www.tinkercad.com/learn/circuits)
- [Arduino CLI](https://arduino.github.io/arduino-cli/)

---

# Tinkercad Desktop

Electron desktop application that integrates Tinkercad (Autodesk) with Arduino features to compile and upload code directly from the interface.

![Screenshot](capture.png)

## 📋 Description

Tinkercad Desktop is an application that allows you to use Tinkercad in a native desktop window, with additional features for working with Arduino. The application integrates Arduino CLI to compile and upload your sketches directly from the Tinkercad code editor.

## ✨ Features

- **Integrated Tinkercad Interface** : Full access to Tinkercad Circuits in a desktop application
- **Arduino Compilation and Upload** : Compiles and uploads your Arduino code directly from Tinkercad
- **Automatic Board Detection** : Automatically detects connected Arduino boards
- **Code Copy** : Easily copy code from the Tinkercad editor to the clipboard (shortcut: `Ctrl+Alt+C`)
- **Library Installation** : Install Arduino libraries directly from the application
- **Multilingual** : Support for French and English with automatic system language detection
- **Compiler Installation** : Automatic installation of Arduino AVR compiler if needed

## 📖 Usage

### First Use

1. Launch the application
2. Connect your Arduino Uno board to your computer
3. The application will automatically detect the board in the "List available boards" menu
4. Select the COM port corresponding to your board

### Compile and Upload Code

1. Open Tinkercad Circuits and create your circuit (otherwise an error message will appear)
2. Write or modify your program in blocks or Arduino code
3. Go to the **Arduino > Upload Code** menu
4. The code will be automatically compiled and then uploaded to your board

### Copy Code

- Use the shortcut `Ctrl+Alt+C` or go to **File > Copy Code**
- The code will be copied to the clipboard

### Install a Library

1. Go to **Arduino > Install a Library**
2. Enter the library name (e.g., `Servo`, `LiquidCrystal`, etc.)
3. The library will be installed via Arduino CLI

### Install Arduino Compiler

If this is the first time you're using the application:
1. Go to **Arduino > Install Arduino Compiler**
2. Wait for the installation to complete

### Change Language

1. Go to **File > Language**
2. Select **English** or **Français**

## 📝 Important Notes

- The application requires an Internet connection to access Tinkercad
- Installed libraries are stored in the Arduino CLI configuration folder

## 👤 Author

**Sébastien Canet**

## 📄 License

This project is licensed under CC0-1.0 (Creative Commons Zero).

## 🤝 Contributing

Contributions are welcome! Feel free to open an issue or a pull request.

## 🔗 Useful Links

- [Tinkercad](https://www.tinkercad.com)
- [Tinkercad Circuits Documentation](https://www.tinkercad.com/learn/circuits)
- [Arduino CLI](https://arduino.github.io/arduino-cli/)
